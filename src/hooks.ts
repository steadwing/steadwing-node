import { getBreadcrumbs } from "./breadcrumbs";
import { scrub } from "./scrubber";
import type { ExceptionEvent, StackFrame } from "./types";

const MAX_STACK_FRAMES = 50;
const MAX_LOCAL_VAR_LENGTH = 1024;

export type ExceptionCallback = (
  event: ExceptionEvent,
  flush: boolean
) => void | Promise<void>;

let onExceptionCallback: ExceptionCallback | null = null;
let patched = false;
let terminating = false;

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

/**
 * Restore Node's default fatal behavior after capturing the error.
 *
 * Registering an "uncaughtException"/"unhandledRejection" listener overrides
 * Node's default crash-and-exit. An observability SDK must not silently keep a
 * process alive in a corrupted state, so once the event has been flushed we
 * replicate the default: print the error and exit non-zero — but ONLY if we are
 * the sole listener. If the application registered its own handler, it has taken
 * ownership of termination and we defer to it.
 */
function restoreFatalBehavior(eventName: "uncaughtException" | "unhandledRejection", err: Error): void {
  if (terminating) return;
  if (process.listenerCount(eventName) > 1) return; // app owns termination
  terminating = true;
  try {
    // eslint-disable-next-line no-console
    console.error(err);
  } catch {
    // ignore
  }
  process.exit(1);
}

async function handleUncaughtException(err: Error): Promise<void> {
  try {
    if (onExceptionCallback) {
      const event = buildExceptionEvent(err);
      await onExceptionCallback(event, true);
    }
  } catch {
    // Never throw from the error handler
  }
  restoreFatalBehavior("uncaughtException", err);
}

async function handleUnhandledRejection(reason: unknown): Promise<void> {
  const err =
    reason instanceof Error ? reason : new Error(String(reason));
  try {
    if (onExceptionCallback) {
      const event = buildExceptionEvent(err);
      await onExceptionCallback(event, true);
    }
  } catch {
    // Never throw from the error handler
  }
  restoreFatalBehavior("unhandledRejection", err);
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
