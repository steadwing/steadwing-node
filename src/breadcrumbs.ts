import * as http from "http";
import * as https from "https";
import type { Breadcrumb } from "./types";

const MAX_BREADCRUMBS = 100;
const breadcrumbs: Breadcrumb[] = [];
let patched = false;
let inSdkCall = false;

let originalHttpRequest: typeof http.request | null = null;
let originalHttpsRequest: typeof https.request | null = null;

export function getBreadcrumbs(): Breadcrumb[] {
  return breadcrumbs.slice();
}

export function clearBreadcrumbs(): void {
  breadcrumbs.length = 0;
}

export function addBreadcrumb(breadcrumb: Breadcrumb): void {
  breadcrumbs.push(breadcrumb);
  if (breadcrumbs.length > MAX_BREADCRUMBS) {
    breadcrumbs.shift();
  }
}

export function markSdkCall(): void {
  inSdkCall = true;
}

export function unmarkSdkCall(): void {
  inSdkCall = false;
}

function wrapRequest(
  originalFn: typeof http.request,
  protocol: string
): typeof http.request {
  return function wrappedRequest(
    this: unknown,
    ...args: Parameters<typeof http.request>
  ): http.ClientRequest {
    if (inSdkCall) {
      return originalFn.apply(this, args);
    }

    const start = Date.now();
    const req = originalFn.apply(this, args);

    // Extract method and URL from the request
    const method = req.method || "GET";
    let url = "";
    try {
      const urlArg = args[0];
      if (typeof urlArg === "string") {
        url = urlArg;
      } else if (urlArg instanceof URL) {
        url = urlArg.toString();
      } else if (typeof urlArg === "object" && urlArg !== null) {
        const opts = urlArg as http.RequestOptions;
        const host = opts.hostname || opts.host || "unknown";
        const path = opts.path || "/";
        url = `${protocol}://${host}${path}`;
      }
    } catch {
      url = "unknown";
    }

    req.on("response", (res: http.IncomingMessage) => {
      const durationMs = Date.now() - start;
      addBreadcrumb({
        type: "http",
        timestamp: start / 1000,
        data: {
          method,
          url,
          status_code: res.statusCode,
          duration_ms: durationMs,
        },
      });
    });

    req.on("error", (err: Error) => {
      const durationMs = Date.now() - start;
      addBreadcrumb({
        type: "http",
        timestamp: start / 1000,
        data: {
          method,
          url,
          duration_ms: durationMs,
          error: err.message.substring(0, 256),
        },
      });
    });

    return req;
  } as typeof http.request;
}

export function patchHttp(): void {
  if (patched) return;

  try {
    originalHttpRequest = http.request;
    (http as { request: typeof http.request }).request = wrapRequest(
      originalHttpRequest,
      "http"
    );

    originalHttpsRequest = https.request;
    (https as { request: typeof https.request }).request = wrapRequest(
      originalHttpsRequest,
      "https"
    );

    patched = true;
  } catch {
    // Silent fail
  }
}

export function unpatchHttp(): void {
  if (!patched) return;

  try {
    if (originalHttpRequest) {
      (http as { request: typeof http.request }).request = originalHttpRequest;
    }
    if (originalHttpsRequest) {
      (https as { request: typeof https.request }).request = originalHttpsRequest;
    }
    patched = false;
  } catch {
    // Silent fail
  }
}
