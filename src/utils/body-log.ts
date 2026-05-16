// Request-body logging hygiene. Two concerns:
//  - skip paths whose request bodies are entirely user vault content (H-C)
//  - redact credential + user-content field values on every other route (M3)

// Credential keys + user-content field names. The JSON replacer below applies
// at every nesting level. Content fields (content/text/query/...) added
// 2026-05-16 (M3) — they can carry vault note bodies / search queries.
export const SENSITIVE_BODY_KEYS = new Set([
  "password",
  "email",
  "code_verifier",
  "client_secret",
  "refresh_token",
  "access_token",
  "bearer",
  "jwt",
  "token",
  "code",
  "content",
  "text",
  "query",
  "message",
  "note",
  "body",
  "edits",
  "remembered_text",
]);

// Routes whose request bodies are entirely user vault content. We log a
// body=[skipped] sentinel — same timestamp/method/path signal as every other
// request, no plaintext to stderr. Exact-match paths only. /mcp added
// 2026-05-16 (H-C).
export const BODY_LOG_SKIP_PATHS = new Set<string>([
  "/api/sync/push",
  "/api/first-wow",
  "/mcp",
]);

// Loggable representation of a request body: a [skipped] sentinel for
// content-bearing routes, otherwise a redacted, 300-char-capped JSON string.
export function formatRequestBody(path: string, body: unknown): string {
  if (BODY_LOG_SKIP_PATHS.has(path)) return "[skipped]";
  if (!body) return "";
  return JSON.stringify(body, (key, value) =>
    SENSITIVE_BODY_KEYS.has(key) ? "[redacted]" : value,
  ).slice(0, 300);
}
