import { buildExceptionEvent, type ExceptionCallback } from "../hooks";
import { scrub } from "../scrubber";

let onExceptionCb: ExceptionCallback | null = null;

export function patchExpress(onException: ExceptionCallback): void {
  onExceptionCb = onException;
}

export function expressErrorHandler() {
  return function steadwingErrorHandler(
    err: Error,
    req: any,
    res: any,
    next: (err?: Error) => void
  ) {
    try {
      if (onExceptionCb) {
        const event = buildExceptionEvent(err);
        event.request_context = {
          method: req.method,
          url_path: req.originalUrl || req.url,
          query_string: req.query ? JSON.stringify(req.query) : undefined,
          status_code: res.statusCode >= 400 ? res.statusCode : 500,
          headers: scrub(req.headers) as Record<string, unknown>,
        };
        onExceptionCb(event, false);
      }
    } catch {
      // Silent
    }
    next(err);
  };
}

export function unpatchExpress(): void {
  onExceptionCb = null;
}
