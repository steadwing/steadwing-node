import { createHash } from "crypto";
import { markSdkCall, unmarkSdkCall } from "./breadcrumbs";
import { SDK_VERSION } from "./types";
import type { ExceptionEvent } from "./types";

const FLUSH_INTERVAL_MS = 5000;
const FLUSH_BATCH_SIZE = 100;
const MAX_EVENT_SIZE_BYTES = 512 * 1024;
const MAX_QUEUE_SIZE = 256;
const DEDUP_WINDOW_MS = 60000;
const DEDUP_CACHE_MAX_SIZE = 1000;
const HTTP_TIMEOUT_MS = 5000;

interface DedupEntry {
  ts: number;
  event: Record<string, unknown>;
}

interface SendResult {
  ok: boolean;
  status: number | null;
  error?: string;
}

export type DeliveryStatus = "ok" | "degraded" | "unauthorized" | "never_sent";

export interface TransportHealth {
  status: DeliveryStatus;
  lastStatusCode: number | null;
  lastError: string | null;
  eventsSent: number;
  eventsDropped: number;
  queued: number;
}

export class Transport {
  private apiKey: string;
  private backendUrl: string;
  private queue: Array<Record<string, unknown>> = [];
  private dedupCache = new Map<string, DedupEntry>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private shutdown = false;

  // Delivery health / diagnostics.
  private authFailed = false;
  private authWarned = false;
  private lastStatusCode: number | null = null;
  private lastError: string | null = null;
  private hadSuccess = false;
  private eventsSent = 0;
  private eventsDropped = 0;

  constructor(apiKey: string, backendUrl: string) {
    this.apiKey = apiKey;
    this.backendUrl = backendUrl.replace(/\/$/, "");
  }

  start(): void {
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);

    // Don't keep the process alive just for flushing
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  enqueue(event: Record<string, unknown>): void {
    try {
      // Truncate oversized events
      const eventJson = JSON.stringify(event);
      if (Buffer.byteLength(eventJson, "utf8") > MAX_EVENT_SIZE_BYTES) {
        if (event.traceback && typeof event.traceback === "string") {
          event.traceback =
            (event.traceback as string).substring(0, 10000) + "...[truncated]";
        }
        if (Array.isArray(event.frames)) {
          event.frames = (event.frames as unknown[]).slice(0, 10);
        }
        if (Array.isArray(event.breadcrumbs)) {
          event.breadcrumbs = (event.breadcrumbs as unknown[]).slice(-50);
        }
      }

      // Deduplication for exceptions
      if (event.type === "exception") {
        const dedupKey = this.getDedupKey(event as unknown as ExceptionEvent);
        if (dedupKey) {
          const now = Date.now();
          const entry = this.dedupCache.get(dedupKey);
          if (entry && now - entry.ts < DEDUP_WINDOW_MS) {
            // Same error within window — bump count on the original
            const original = entry.event;
            if (this.queue.includes(original)) {
              original.count = ((original.count as number) || 1) + 1;
              return;
            }
          }
          event.count = 1;
          this.dedupCache.set(dedupKey, { ts: now, event });
          if (this.dedupCache.size > DEDUP_CACHE_MAX_SIZE) {
            const firstKey = this.dedupCache.keys().next().value;
            if (firstKey) this.dedupCache.delete(firstKey);
          }
        }
      }

      if (this.queue.length >= MAX_QUEUE_SIZE) {
        this.eventsDropped += 1;
        return;
      }
      this.queue.push(event);

      if (this.queue.length >= FLUSH_BATCH_SIZE) {
        void this.flush();
      }
    } catch {
      // Silent
    }
  }

  private getDedupKey(event: ExceptionEvent): string | null {
    try {
      const excType = event.exception_type || "";
      const frames = event.frames || [];
      let keyStr: string;
      if (frames.length > 0) {
        const topFrame = frames[frames.length - 1];
        keyStr = `${excType}:${topFrame.filename}:${topFrame.lineno}`;
      } else {
        keyStr = `${excType}:unknown`;
      }
      return createHash("md5").update(keyStr).digest("hex");
    } catch {
      return null;
    }
  }

  /**
   * Flush queued events, inspecting the response so failures aren't lost:
   * a rejected key stops delivery (warned once), permanent client errors drop
   * the batch, and transient failures (429/5xx/network) are put back on the
   * queue to retry on the next flush. Resolves when the request completes.
   */
  async flush(): Promise<void> {
    if (this.authFailed) {
      // Known-bad key — draining keeps memory bounded without pointless calls.
      this.eventsDropped += this.queue.length;
      this.queue = [];
      return;
    }
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0);
    let result: SendResult;
    try {
      const zlib = require("zlib");
      const compressed = zlib.gzipSync(
        Buffer.from(JSON.stringify({ events: batch }), "utf8"),
        { level: 6 }
      );
      result = await this.send(compressed);
    } catch (err) {
      result = { ok: false, status: null, error: String(err) };
    }

    if (result.ok) {
      this.hadSuccess = true;
      this.eventsSent += batch.length;
      this.lastStatusCode = result.status;
      this.lastError = null;
    } else if (result.status === 401 || result.status === 403) {
      this.authFailed = true;
      this.lastStatusCode = result.status;
      this.lastError = `authentication rejected (HTTP ${result.status})`;
      this.eventsDropped += batch.length;
      if (!this.authWarned) {
        this.authWarned = true;
        // eslint-disable-next-line no-console
        console.error(
          `[steadwing] API key rejected (HTTP ${result.status}). Events will ` +
            `NOT be delivered. Check your Steadwing API key.`
        );
      }
    } else if (
      result.status !== null &&
      result.status >= 400 &&
      result.status < 500 &&
      result.status !== 429
    ) {
      // Other 4xx won't be fixed by retrying this payload — drop it.
      this.lastStatusCode = result.status;
      this.lastError = `HTTP ${result.status}`;
      this.eventsDropped += batch.length;
    } else {
      // Transient: 429, 5xx, network error, timeout — retain and retry.
      this.lastStatusCode = result.status;
      this.lastError = result.error ?? `HTTP ${result.status}`;
      this.queue = batch.concat(this.queue).slice(0, MAX_QUEUE_SIZE);
    }
  }

  private send(compressed: Buffer): Promise<SendResult> {
    return new Promise<SendResult>((resolve) => {
      let settled = false;
      const done = (r: SendResult) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };

      try {
        markSdkCall();
        const url = new URL(`${this.backendUrl}/api/ingest`);
        const isHttps = url.protocol === "https:";
        const httpModule = isHttps ? require("https") : require("http");

        const req = httpModule.request(
          {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname,
            method: "POST",
            timeout: HTTP_TIMEOUT_MS,
            headers: {
              "X-API-Key": this.apiKey,
              "X-Steadwing-SDK-Version": `node/${SDK_VERSION}`,
              "Content-Type": "application/json",
              "Content-Encoding": "gzip",
              "Content-Length": compressed.length,
            },
          },
          (res: { statusCode?: number; resume: () => void }) => {
            const status = res.statusCode ?? 0;
            res.resume(); // drain so the socket frees
            done({ ok: status >= 200 && status < 300, status });
          }
        );

        req.on("error", (e: Error) =>
          done({ ok: false, status: null, error: e.message })
        );
        req.on("timeout", () => req.destroy(new Error("request timeout")));

        req.write(compressed);
        req.end();
      } catch (err) {
        done({ ok: false, status: null, error: String(err) });
      } finally {
        // Only request creation needs to be marked; the async response makes no
        // new outbound requests.
        unmarkSdkCall();
      }
    });
  }

  /**
   * Best-effort flush that resolves within `timeoutMs` even on a slow network,
   * so a crash/exit event is sent without blocking process teardown forever.
   */
  async flushAndWait(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      if (timer.unref) timer.unref();
    });
    try {
      await Promise.race([this.flush(), timeout]);
    } catch {
      // Never throw from a flush.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Snapshot of delivery health for diagnostics. */
  getHealth(): TransportHealth {
    let status: DeliveryStatus;
    if (this.authFailed) {
      status = "unauthorized";
    } else if (!this.hadSuccess && this.lastError === null) {
      status = "never_sent";
    } else if (this.lastError !== null) {
      status = "degraded";
    } else {
      status = "ok";
    }
    return {
      status,
      lastStatusCode: this.lastStatusCode,
      lastError: this.lastError,
      eventsSent: this.eventsSent,
      eventsDropped: this.eventsDropped,
      queued: this.queue.length,
    };
  }

  stop(): Promise<void> {
    this.shutdown = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    return this.flushAndWait(HTTP_TIMEOUT_MS);
  }
}
