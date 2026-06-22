import { buildExceptionEvent, type ExceptionCallback } from "../hooks";
import { scrub } from "../scrubber";

let patched = false;

export function patchFastify(onException: ExceptionCallback): void {
  if (patched) return;

  try {
    const fastify = require("fastify");
    const originalFastify = fastify;

    const wrappedFastify = function (this: unknown, ...args: unknown[]) {
      const app = originalFastify.apply(this, args);

      app.addHook(
        "onError",
        (request: any, reply: any, error: Error, done: () => void) => {
          try {
            const event = buildExceptionEvent(error);
            event.request_context = {
              method: request.method,
              url_path: request.url,
              query_string: request.query
                ? JSON.stringify(request.query)
                : undefined,
              status_code: reply.statusCode >= 400 ? reply.statusCode : 500,
              headers: scrub(request.headers) as Record<string, unknown>,
            };
            onException(event, false);
          } catch {
            // Silent
          }
          done();
        }
      );

      return app;
    };

    // Copy properties from original fastify
    Object.assign(wrappedFastify, originalFastify);

    // Replace in require cache
    const cacheKey = require.resolve("fastify");
    if (require.cache[cacheKey]) {
      require.cache[cacheKey]!.exports = wrappedFastify;
    }

    patched = true;
  } catch {
    // fastify not installed
  }
}

export function unpatchFastify(): void {
  patched = false;
}
