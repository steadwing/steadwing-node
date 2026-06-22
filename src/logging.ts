import { addBreadcrumb } from "./breadcrumbs";
import type { LogEvent } from "./types";

export type LogEventCallback = (event: LogEvent) => void;

let patched = false;
let onLogEventCallback: LogEventCallback | null = null;

let originalConsoleError: typeof console.error | null = null;
let originalConsoleWarn: typeof console.warn | null = null;

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

function patchConsole(): void {
  originalConsoleError = console.error;
  originalConsoleWarn = console.warn;

  console.error = (...args: unknown[]) => {
    try {
      const message = formatArgs(args);
      addBreadcrumb({
        type: "log",
        timestamp: Date.now() / 1000,
        data: { level: "error", message },
      });
      if (onLogEventCallback) {
        onLogEventCallback({
          message,
          level: "error",
          timestamp: Date.now() / 1000,
        });
      }
    } catch {
      // Silent
    }
    originalConsoleError!.apply(console, args);
  };

  console.warn = (...args: unknown[]) => {
    try {
      addBreadcrumb({
        type: "log",
        timestamp: Date.now() / 1000,
        data: { level: "warn", message: formatArgs(args) },
      });
    } catch {
      // Silent
    }
    originalConsoleWarn!.apply(console, args);
  };
}

function patchWinston(): void {
  try {
    const winston = require("winston");
    const transport = new winston.transports.Stream({
      stream: {
        write(message: string) {
          try {
            const parsed = JSON.parse(message);
            const level = (parsed.level || "info").toLowerCase();
            const msg = parsed.message || message;

            addBreadcrumb({
              type: "log",
              timestamp: Date.now() / 1000,
              data: { level, message: msg },
            });

            if (
              (level === "error" || level === "crit" || level === "emerg") &&
              onLogEventCallback
            ) {
              onLogEventCallback({
                message: msg,
                level,
                timestamp: Date.now() / 1000,
                module: parsed.service,
              });
            }
          } catch {
            // Not JSON, treat as plain message
            addBreadcrumb({
              type: "log",
              timestamp: Date.now() / 1000,
              data: { level: "info", message: message.trim() },
            });
          }
        },
      },
      format: winston.format.json(),
    });

    // Add to the default logger if it exists
    if (winston.defaultMeta !== undefined || winston.transports) {
      winston.add(transport);
    }
  } catch {
    // winston not installed
  }
}

function patchPino(): void {
  try {
    const pino = require("pino");
    const originalPino = pino;

    // Wrap pino to add our destination hook
    const wrappedPino = function (this: unknown, ...args: unknown[]) {
      const opts =
        typeof args[0] === "object" && args[0] !== null ? args[0] : {};
      const originalHooks = (opts as Record<string, unknown>).hooks || {};

      (opts as Record<string, unknown>).hooks = {
        ...(originalHooks as object),
        logMethod(
          inputArgs: unknown[],
          method: (...a: unknown[]) => void,
          level: number
        ) {
          try {
            const message = formatArgs(inputArgs);
            const levelName = levelToName(level);

            addBreadcrumb({
              type: "log",
              timestamp: Date.now() / 1000,
              data: { level: levelName, message },
            });

            if (
              (level >= 50) && // error = 50, fatal = 60 in pino
              onLogEventCallback
            ) {
              onLogEventCallback({
                message,
                level: levelName,
                timestamp: Date.now() / 1000,
              });
            }
          } catch {
            // Silent
          }
          method.apply(this, inputArgs);
        },
      };

      args[0] = opts;
      return originalPino.apply(this, args);
    };

    // Copy properties from original pino
    Object.assign(wrappedPino, originalPino);

    // Replace in require cache
    const cacheKey = require.resolve("pino");
    if (require.cache[cacheKey]) {
      require.cache[cacheKey]!.exports = wrappedPino;
    }
  } catch {
    // pino not installed
  }
}

function levelToName(level: number): string {
  if (level >= 60) return "fatal";
  if (level >= 50) return "error";
  if (level >= 40) return "warn";
  if (level >= 30) return "info";
  if (level >= 20) return "debug";
  return "trace";
}

export function installLogging(onLogEvent: LogEventCallback): void {
  if (patched) return;

  onLogEventCallback = onLogEvent;
  patchConsole();
  patchWinston();
  patchPino();
  patched = true;
}

export function uninstallLogging(): void {
  if (!patched) return;

  if (originalConsoleError) {
    console.error = originalConsoleError;
  }
  if (originalConsoleWarn) {
    console.warn = originalConsoleWarn;
  }

  onLogEventCallback = null;
  patched = false;
}
