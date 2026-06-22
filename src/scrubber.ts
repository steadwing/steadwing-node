const DENY_LIST = new Set([
  "password",
  "passwd",
  "secret",
  "api_key",
  "apikey",
  "token",
  "auth",
  "authorization",
  "cookie",
  "csrf",
  "session",
  "credit_card",
  "ssn",
]);

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 10;

function isSensitiveKey(key: string): boolean {
  return DENY_LIST.has(key.toLowerCase());
}

export function scrub(data: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH) return data;

  if (data === null || data === undefined) return data;

  if (Array.isArray(data)) {
    return data.map((item) => scrub(item, depth + 1));
  }

  if (typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        result[key] = REDACTED;
      } else {
        result[key] = scrub(value, depth + 1);
      }
    }
    return result;
  }

  return data;
}
