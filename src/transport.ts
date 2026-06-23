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

export class Transport {
  private apiKey: string;
  private backendUrl: string;
  private queue: Array<Record<string, unknown>> = [];
  private dedupCache = new Map<string, DedupEntry>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private shutdown = false;

  constructor(apiKey: string, backendUrl: string) {
    this.apiKey = apiKey;
    this.backendUrl = backendUrl.replace(/\/$/, "");
  }

  start(): void {
    this.flushTimer = setInterval(() => {
      this.flush();
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

      if (this.queue.length >= MAX_QUEUE_SIZE) return;
      this.queue.push(event);

      if (this.queue.length >= FLUSH_BATCH_SIZE) {
        this.flush();
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

  flush(): void {
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0);
    const payload = JSON.stringify({ events: batch });

    try {
      markSdkCall();
      const zlib = require("zlib");
      const compressed = zlib.gzipSync(Buffer.from(payload, "utf8"), {
        level: 6,
      });

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
        () => {
          // Response ignored — fire and forget
        }
      );

      req.on("error", () => {
        // Silent — backend down, drop events
      });
      req.on("timeout", () => {
        req.destroy();
      });

      req.write(compressed);
      req.end();
    } catch {
      // Silent
    } finally {
      unmarkSdkCall();
    }
  }

  flushSync(): void {
    this.flush();
  }

  stop(): void {
    this.shutdown = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }
}
