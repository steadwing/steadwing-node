import { buildExceptionEvent, type ExceptionCallback } from "../hooks";
import { scrub } from "../scrubber";

let patched = false;

export function patchExpress(onException: ExceptionCallback): void {
  if (patched) return;

  try {
    const express = require("express");

    const originalInit = express.application.init;

    express.application.init = function (this: any, ...args: unknown[]) {
      const result = originalInit.apply(this, args);

      // Add Steadwing error handler on first request
      const originalListen = this.listen;
      this.listen = function (...listenArgs: unknown[]) {
        // Add error-handling middleware at the end of the stack
        this.use(
          (
            err: Error,
            req: any,
            res: any,
            next: (err?: Error) => void
          ) => {
            try {
              const event = buildExceptionEvent(err);
              event.request_context = {
                method: req.method,
                url_path: req.originalUrl || req.url,
                query_string: req.query
                  ? JSON.stringify(req.query)
                  : undefined,
                status_code: res.statusCode >= 400 ? res.statusCode : 500,
                headers: scrub(req.headers) as Record<string, unknown>,
              };
              onException(event, false);
            } catch {
              // Silent
            }
            next(err);
          }
        );
        return originalListen.apply(this, listenArgs);
      };

      return result;
    };

    patched = true;
  } catch {
    // express not installed
  }
}

export function unpatchExpress(): void {
  patched = false;
}
