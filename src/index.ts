import { SteadwingClient } from "./client";
import { buildExceptionEvent } from "./hooks";
import { expressErrorHandler } from "./integrations/express";
import { fastifyErrorHandler } from "./integrations/fastify";
import type { SteadwingConfig } from "./types";
import type { TransportHealth } from "./transport";

export type { SteadwingConfig } from "./types";
export type { TransportHealth } from "./transport";
export { expressErrorHandler, fastifyErrorHandler };

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
  client.handleException(event, false);
}

export function captureMessage(
  message: string,
  level: string = "info"
): void {
  const client = SteadwingClient.getInstance();
  if (!client) return;

  client.handleLogEvent({
    message,
    level,
    timestamp: Date.now() / 1000,
  });
}

/**
 * Current delivery health — lets an app verify events are actually reaching
 * Steadwing instead of silently failing (e.g. bad key, backend down).
 * Returns null if the SDK has not been initialized.
 */
export function getHealth(): TransportHealth | null {
  const client = SteadwingClient.getInstance();
  return client ? client.getHealth() : null;
}
