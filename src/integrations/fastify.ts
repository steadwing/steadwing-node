import { buildExceptionEvent, type ExceptionCallback } from "../hooks";
import { scrub } from "../scrubber";

let onExceptionCb: ExceptionCallback | null = null;

export function patchFastify(onException: ExceptionCallback): void {
  onExceptionCb = onException;
}

/**
 * Fastify error handler plugin. Register with:
 *
 *   app.register(steadwing.fastifyErrorHandler());
 */
export function fastifyErrorHandler() {
  return function steadwingPlugin(fastify: any, _opts: any, done: () => void) {
    fastify.addHook(
      "onError",
      (request: any, reply: any, error: Error, done: () => void) => {
        try {
          if (onExceptionCb) {
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
            onExceptionCb(event, false);
          }
        } catch {
          // Silent
        }
        done();
      }
    );
    done();
  };
}

export function unpatchFastify(): void {
  onExceptionCb = null;
}
