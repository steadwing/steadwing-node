# KT: Steadwing Node SDK

## What it is

This is the npm package `@steadwing/node`. A Node.js app installs it and calls `init({ apiKey })` once. After that, the SDK watches the app for errors and sends them to Steadwing's backend (`https://api.steadwing.com/api/ingest`). Steadwing then runs an AI root cause analysis on them.

Think of it as a small Sentry-style error reporter.

## What it captures

- **Crashes**: uncaught exceptions and unhandled promise rejections.
- **Error logs**: `console.error`, plus error-level logs from winston and pino if the app has them installed.
- **Breadcrumbs**: the last 100 things that happened before an error, such as outgoing HTTP calls, warnings and log lines. These get attached to each exception so you can see what led up to it.
- **Web framework errors**: route errors in Express and Fastify, along with request details (method, path, headers with secrets removed). The app has to add our handler for this to work.
- **Heartbeats**: a "still alive" ping every 60 seconds.
- **Manual calls**: `captureException(err)` and `captureMessage(msg)`.

Every event also includes basic runtime info: Node version, OS, hostname, container ID and git SHA.

## How it works

| File | What it does |
|------|--------------|
| `src/index.ts` | The public API: `init`, `captureException`, `captureMessage`, `getHealth`, plus the Express/Fastify handlers. |
| `src/client.ts` | The main singleton. On `init` it turns everything on and flushes events when the process shuts down (SIGTERM/SIGINT/beforeExit). |
| `src/hooks.ts` | Catches crashes and turns an `Error` into an event (parsed stack frames, `cause` chain). After a crash it still exits the process with code 1, unless the app has its own crash handler. |
| `src/logging.ts` | Wraps `console.error`/`console.warn` and hooks into winston and pino. |
| `src/breadcrumbs.ts` | Wraps `http`/`https` `request` and `get` to record outgoing calls. It skips the SDK's own calls. |
| `src/transport.ts` | Puts events in a queue and sends them in gzipped batches every 5 seconds (or sooner if 100 build up). Also handles dedup, retries and health tracking. |
| `src/scrubber.ts` | Replaces sensitive header values (`authorization`, `cookie`, `token`, etc.) with `[REDACTED]`. |
| `src/integrations/` | The Express error middleware and the Fastify `onError` plugin. |

## Delivery rules (transport)

- The queue holds at most 256 events. Anything beyond that is dropped and counted.
- If the same exception (same type, file and line) happens again within 60 seconds, it bumps a `count` on the queued event instead of sending a new one.
- **401/403** means a bad API key. It logs a warning once and stops sending.
- **Other 4xx** errors drop the batch.
- **429, 5xx and network errors** put the batch back in the queue to retry later.
- On a crash, it waits up to 2 seconds for the event to send before the process exits.
- The SDK never throws into the host app. Every hook is wrapped in try/catch and fails silently.

## Dev and release

- `npm run build` builds CommonJS, ESM and type definitions into `dist/`.
- **Every push to `main` publishes to npm** (`.github/workflows/publish.yml`). Bump the version in `package.json` before merging, or the publish will fail.
- For local testing against a different backend, set `STEADWING_BACKEND_URL`.
