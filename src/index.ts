import { SteadwingClient } from "./client";
import { buildExceptionEvent } from "./hooks";
import type { SteadwingConfig } from "./types";

export type { SteadwingConfig } from "./types";

export function init(config: SteadwingConfig): SteadwingClient {
  const existing = SteadwingClient.getInstance();
  if (existing) return existing;

  const client = new SteadwingClient(config);
  SteadwingClient.setInstance(client);
  return client;
}

export function captureException(err?: Error | unknown): void {
  const client = SteadwingClient.getInstance();
  if (!client) return;

  const error =
    err instanceof Error ? err : new Error(err ? String(err) : "Unknown error");
  const event = buildExceptionEvent(error);
  (client as any).handleException(event, false);
}

export function captureMessage(
  message: string,
  level: string = "info"
): void {
  const client = SteadwingClient.getInstance();
  if (!client) return;

  (client as any).handleLogEvent({
    message,
    level,
    timestamp: Date.now() / 1000,
  });
}
