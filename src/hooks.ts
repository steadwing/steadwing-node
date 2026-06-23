import { getBreadcrumbs } from "./breadcrumbs";
import { scrub } from "./scrubber";
import type { ExceptionEvent, StackFrame } from "./types";

const MAX_STACK_FRAMES = 50;
const MAX_LOCAL_VAR_LENGTH = 1024;

export type ExceptionCallback = (
  event: ExceptionEvent,
  flush: boolean
) => void;

let onExceptionCallback: ExceptionCallback | null = null;
let patched = false;

function parseStackTrace(stack: string | undefined): StackFrame[] {
  if (!stack) return [];

  const frames: StackFrame[] = [];
  const lines = stack.split("\n");

  for (const line of lines) {
    const match = line.match(
      /^\s+at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/
    );
    if (match) {
      frames.push({
        filename: match[2],
        lineno: parseInt(match[3], 10),
        colno: parseInt(match[4], 10),
        function: match[1] || "<anonymous>",
      });
    }
  }

  if (frames.length > MAX_STACK_FRAMES) {
    return frames.slice(0, MAX_STACK_FRAMES);
  }
  return frames;
}

function extractExceptionChain(
  err: Error
): Array<{ type: string; message: string }> {
  const chain: Array<{ type: string; message: string }> = [];
  const seen = new Set<Error>();
  let current: Error | undefined = err;

  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push({
      type: current.constructor.name || "Error",
      message: current.message,
    });
    current = (current as { cause?: Error }).cause;
  }

  return chain;
}

export function buildExceptionEvent(err: Error): ExceptionEvent {
  const frames = parseStackTrace(err.stack).reverse();
  const traceback = err.stack || `${err.name}: ${err.message}`;

  return {
    exception_type: err.constructor.name || "Error",
    exception_message: err.message,
    traceback,
    frames,
    exception_chain: extractExceptionChain(err),
    breadcrumbs: getBreadcrumbs(),
  };
}

function handleUncaughtException(err: Error): void {
  try {
    if (onExceptionCallback) {
      const event = buildExceptionEvent(err);
      onExceptionCallback(event, true);
    }
  } catch {
    // Never throw from the error handler
  }
}

function handleUnhandledRejection(reason: unknown): void {
  try {
    if (onExceptionCallback) {
      const err =
        reason instanceof Error
          ? reason
          : new Error(String(reason));
      const event = buildExceptionEvent(err);
      onExceptionCallback(event, true);
    }
  } catch {
    // Never throw from the error handler
  }
}

export function patchHooks(onException: ExceptionCallback): void {
  if (patched) return;

  onExceptionCallback = onException;

  process.on("uncaughtException", handleUncaughtException);
  process.on("unhandledRejection", handleUnhandledRejection);

  patched = true;
}

export function unpatchHooks(): void {
  if (!patched) return;

  process.removeListener("uncaughtException", handleUncaughtException);
  process.removeListener("unhandledRejection", handleUnhandledRejection);
  onExceptionCallback = null;
  patched = false;
}
