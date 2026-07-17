import { patchHttp } from "./breadcrumbs";
import { patchHooks, type ExceptionCallback } from "./hooks";
import { installLogging } from "./logging";
import { patchExpress } from "./integrations/express";
import { patchFastify } from "./integrations/fastify";
import { Transport, type TransportHealth } from "./transport";
import {
  baseEvent,
  buildRuntimeInfo,
  type BaseEvent,
  type ExceptionEvent,
  type LogEvent,
  type RuntimeInfo,
  type SteadwingConfig,
} from "./types";

const DEFAULT_BACKEND_URL = "https://api.steadwing.com";
const HEARTBEAT_INTERVAL_MS = 60000;
const FATAL_FLUSH_TIMEOUT_MS = 2000;
type TerminationSignal = "SIGTERM" | "SIGINT";

export class SteadwingClient {
  private static instance: SteadwingClient | null = null;

  private apiKey: string;
  private service: string;
  private env: string;
  private enabled: boolean;
  private backendUrl: string;
  private runtime: RuntimeInfo;
  private transport: Transport | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private isShutdown = false;
  private signalHandlers: Partial<Record<TerminationSignal, () => void>> = {};

  constructor(config: SteadwingConfig) {
    this.apiKey = config.apiKey;
    this.service = config.service || "default";
    this.env = config.env || "PROD";
    this.enabled = config.enabled !== false;
    this.backendUrl =
      process.env.STEADWING_BACKEND_URL || DEFAULT_BACKEND_URL;
    this.runtime = buildRuntimeInfo();

    if (this.enabled) {
      this.setup();
    }
  }

  private setup(): void {
    // Start transport
    this.transport = new Transport(this.apiKey, this.backendUrl);
    this.transport.start();

    // Install exception hooks
    patchHooks(this.handleException.bind(this));

    // Install logging capture
    installLogging(this.handleLogEvent.bind(this));

    // Patch HTTP for breadcrumbs
    patchHttp();

    // Auto-detect and patch frameworks
    this.tryPatchFrameworks();

    // Start heartbeat
    this.startHeartbeat();

    // Graceful shutdown. beforeExit fires when the loop drains naturally; the
    // signal handlers flush and then restore default termination so the SDK is
    // never the reason a container fails to stop.
    process.on("beforeExit", () => {
      void this.shutdown();
    });
    for (const signal of ["SIGTERM", "SIGINT"] as TerminationSignal[]) {
      const handler = () => {
        void this.handleSignal(signal);
      };
      this.signalHandlers[signal] = handler;
      process.on(signal, handler);
    }
  }

  private async handleSignal(signal: TerminationSignal): Promise<void> {
    await this.shutdown();

    // process.on() only ADDS a listener, so ours suppressed Node's default
    // termination without replacing any handler the app installed (those still
    // ran on this same signal). Remove ONLY our listener; if none remain, the
    // SDK was the only thing preventing exit — re-raise so the default action
    // (terminate) takes effect. If the app kept its own handler, it owns
    // termination and we leave it be.
    const handler = this.signalHandlers[signal];
    if (handler) {
      process.removeListener(signal, handler);
      delete this.signalHandlers[signal];
    }
    if (process.listenerCount(signal) === 0) {
      process.kill(process.pid, signal);
    }
  }

  private tryPatchFrameworks(): void {
    patchExpress(this.handleException.bind(this));
    patchFastify(this.handleException.bind(this));
  }

  async handleException(event: ExceptionEvent, flush: boolean): Promise<void> {
    if (!this.enabled || !this.transport) return;

    try {
      const base = baseEvent("exception", this.service, this.env, this.runtime);
      const fullEvent = { ...base, ...event };
      this.transport.enqueue(fullEvent);
      if (flush) {
        // Fatal path — wait (bounded) so the crash event reaches the backend
        // before the process exits, without blocking teardown indefinitely.
        await this.transport.flushAndWait(FATAL_FLUSH_TIMEOUT_MS);
      }
    } catch {
      // Silent
    }
  }

  /** Delivery health snapshot for diagnostics. */
  getHealth(): TransportHealth | null {
    return this.transport ? this.transport.getHealth() : null;
  }

  handleLogEvent(logData: LogEvent): void {
    if (!this.enabled || !this.transport) return;

    try {
      const base = baseEvent("log", this.service, this.env, this.runtime);
      const fullEvent = { ...base, ...logData };
      this.transport.enqueue(fullEvent);
    } catch {
      // Silent
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.isShutdown || !this.transport) return;

      try {
        const event = baseEvent(
          "heartbeat",
          this.service,
          this.env,
          this.runtime
        );
        (event as BaseEvent & { status: string }).status = "healthy";
        this.transport.enqueue(event);
      } catch {
        // Silent
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Don't keep the process alive for heartbeats
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  private async shutdown(): Promise<void> {
    if (this.isShutdown) return;
    this.isShutdown = true;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.transport) {
      await this.transport.stop();
    }
  }

  static getInstance(): SteadwingClient | null {
    return SteadwingClient.instance;
  }

  static setInstance(client: SteadwingClient): void {
    SteadwingClient.instance = client;
  }
}
