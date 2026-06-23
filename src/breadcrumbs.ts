import type { Breadcrumb } from "./types";

const MAX_BREADCRUMBS = 100;
const breadcrumbs: Breadcrumb[] = [];
let patched = false;
let inSdkCall = false;

let originalHttpRequest: Function | null = null;
let originalHttpGet: Function | null = null;
let originalHttpsRequest: Function | null = null;
let originalHttpsGet: Function | null = null;

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

function wrapRequest(originalFn: Function, protocol: string): Function {
  return function wrappedRequest(this: unknown, ...args: unknown[]) {
    if (inSdkCall) {
      return originalFn.apply(this, args);
    }

    const start = Date.now();
    const req = originalFn.apply(this, args);

    const method = req.method || "GET";
    let url = "";
    try {
      const urlArg = args[0];
      if (typeof urlArg === "string") {
        url = urlArg;
      } else if (urlArg instanceof URL) {
        url = urlArg.toString();
      } else if (typeof urlArg === "object" && urlArg !== null) {
        const opts = urlArg as Record<string, unknown>;
        const host = opts.hostname || opts.host || "unknown";
        const path = opts.path || "/";
        url = `${protocol}://${host}${path}`;
      }
    } catch {
      url = "unknown";
    }

    req.on("response", (res: { statusCode?: number }) => {
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
  };
}

export function patchHttp(): void {
  if (patched) return;

  try {
    const httpModule = require("http");
    const httpsModule = require("https");

    originalHttpRequest = httpModule.request;
    httpModule.request = wrapRequest(originalHttpRequest!, "http");

    originalHttpGet = httpModule.get;
    httpModule.get = wrapRequest(originalHttpGet!, "http");

    originalHttpsRequest = httpsModule.request;
    httpsModule.request = wrapRequest(originalHttpsRequest!, "https");

    originalHttpsGet = httpsModule.get;
    httpsModule.get = wrapRequest(originalHttpsGet!, "https");

    patched = true;
  } catch {
    // Silent fail
  }
}

export function unpatchHttp(): void {
  if (!patched) return;

  try {
    const httpModule = require("http");
    const httpsModule = require("https");

    if (originalHttpRequest) httpModule.request = originalHttpRequest;
    if (originalHttpGet) httpModule.get = originalHttpGet;
    if (originalHttpsRequest) httpsModule.request = originalHttpsRequest;
    if (originalHttpsGet) httpsModule.get = originalHttpsGet;

    patched = false;
  } catch {
    // Silent fail
  }
}
