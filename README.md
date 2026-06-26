<div align="center">

# Steadwing Node SDK

**Error monitoring with AI-powered Root Cause Analysis for Node.js applications.**

[npm](https://www.npmjs.com/package/@steadwing/node) | [Docs](https://docs.steadwing.com/node-sdk) | [Discord](https://discord.gg/4rUP86tSXn)

</div>

---

## Overview

The Steadwing Node SDK auto-instruments your application to capture exceptions, error logs, and HTTP breadcrumbs and then sends them to Steadwing for automated Root Cause Analysis.

**Key features:**

- Automatic exception capture (`uncaughtException` + `unhandledRejection`)
- `console.error()`, winston, and pino error-level log forwarding
- HTTP request breadcrumbs for debugging context
- Built-in data scrubbing for sensitive fields
- Framework integrations for Express and Fastify

## Installation

```bash
npm install @steadwing/node
```

**Requires Node.js 18+**

## Quick Start

```javascript
const steadwing = require("@steadwing/node");

steadwing.init({ apiKey: "st_your_api_key" });
```

That's it. Steadwing is now capturing errors in your application.

## Configuration

```javascript
steadwing.init({
  apiKey: "st_...",          // Required: your API key
  service: "my-service",    // Service name for grouping (default: "default")
  env: "PROD",              // Deployment environment (default: "PROD")
  enabled: true,            // Set false to disable
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | - | Your Steadwing API key (required) |
| `service` | `string` | `"default"` | Service name for grouping errors |
| `env` | `string` | `"PROD"` | Deployment environment (`"PROD"`, `"DEV"`, etc.) |
| `enabled` | `boolean` | `true` | Toggle SDK on/off |

> **Note:** Only events sent with `env="PROD"` are considered for auto-monitoring. Events from other environments are received but will not trigger automated RCA.

## Usage

### Automatic Capture

Once initialized, Steadwing automatically captures:

- **Unhandled exceptions** - `uncaughtException` and `unhandledRejection`
- **Error logs** - `console.error()`, winston error-level, pino error-level
- **Breadcrumbs** - outgoing HTTP/HTTPS requests (rolling buffer of last 100)

### Manual Capture

```javascript
const steadwing = require("@steadwing/node");

// Capture a specific exception
try {
  riskyOperation();
} catch (err) {
  steadwing.captureException(err);
}

// Capture a message
steadwing.captureMessage("Deployment completed", "info");
```

## Integrations

| Framework | What's Captured |
|-----------|----------------|
| **Express** | Route errors with request context (method, path, headers) |
| **Fastify** | Route errors with request context via onError hook |
| **winston** | Error-level log capture (auto-detected) |
| **pino** | Error-level log capture (auto-detected) |

### Express

```javascript
const steadwing = require("@steadwing/node");
const express = require("express");

steadwing.init({ apiKey: "st_..." });

const app = express();
app.get("/", (req, res) => res.send("ok"));

// Add as the last middleware
app.use(steadwing.expressErrorHandler());

app.listen(3000);
```

### Fastify

```javascript
const steadwing = require("@steadwing/node");
const fastify = require("fastify");

steadwing.init({ apiKey: "st_..." });

const app = fastify();
app.register(steadwing.fastifyErrorHandler());

app.listen({ port: 3000 });
```

Winston and pino are captured automatically when installed, no extra code needed.

## Data Scrubbing

Sensitive data is automatically scrubbed from captured events. Keys matching the following patterns (case-insensitive) have their values replaced with `[REDACTED]`:

`password` · `passwd` · `secret` · `api_key` · `apikey` · `token` · `auth` · `authorization` · `cookie` · `csrf` · `session` · `credit_card` · `ssn`

## TypeScript

Full TypeScript support with exported types:

```typescript
import { init, captureException, captureMessage, expressErrorHandler } from "@steadwing/node";
import type { SteadwingConfig } from "@steadwing/node";

const config: SteadwingConfig = {
  apiKey: "st_...",
  service: "my-service",
};

init(config);
```

## Contributing

```bash
git clone https://github.com/steadwing/steadwing-node.git
cd steadwing-node
npm install
npm run build
npm test
```

## Community

- [Discord](https://discord.gg/4rUP86tSXn) - Ask questions, share feedback, and connect with the team
- [GitHub Issues](https://github.com/steadwing/steadwing-node/issues) - Report bugs or request features

## License

This project is licensed under the [Apache License 2.0](LICENSE).
