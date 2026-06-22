import { patchHttp } from "./breadcrumbs";
import { patchHooks, type ExceptionCallback } from "./hooks";
import { installLogging } from "./logging";
import { patchExpress } from "./integrations/express";
import { patchFastify } from "./integrations/fastify";
import { Transport } from "./transport";
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

  constructor(config: SteadwingConfig) {
    this.apiKey = config.apiKey;
    this.service = config.service;
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

    // Graceful shutdown
    process.on("beforeExit", () => this.shutdown());
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }

  private tryPatchFrameworks(): void {
    patchExpress(this.handleException.bind(this));
    patchFastify(this.handleException.bind(this));
  }

  private handleException(event: ExceptionEvent, flush: boolean): void {
    if (!this.enabled || !this.transport) return;

    try {
      const base = baseEvent("exception", this.service, this.env, this.runtime);
      const fullEvent = { ...base, ...event };
      this.transport.enqueue(fullEvent);
      if (flush) {
        this.transport.flushSync();
      }
    } catch {
      // Silent
    }
  }

  private handleLogEvent(logData: LogEvent): void {
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

  private shutdown(): void {
    if (this.isShutdown) return;
    this.isShutdown = true;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.transport) {
      this.transport.stop();
    }
  }

  static getInstance(): SteadwingClient | null {
    return SteadwingClient.instance;
  }

  static setInstance(client: SteadwingClient): void {
    SteadwingClient.instance = client;
  }
}
