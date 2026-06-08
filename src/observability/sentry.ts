import * as Sentry from "@sentry/node";
import type { ErrorEvent } from "@sentry/node";
import crypto from "node:crypto";

const VAULT_FIELDS_TO_STRIP = [
  "file_content",
  "content",
  "body",
  "frontmatter",
  "vault_path",
  "path",
  "file_path",
  "query",
  "search_query",
  "keywords",
  "results",
  "candidates",
  "remembered_text",
];

function hashEmail(email: string): string {
  return crypto.createHash("sha256").update(email).digest("hex").slice(0, 12);
}

function scrubObject(obj: unknown): unknown {
  if (!obj || typeof obj !== "object") return obj;
  const out: Record<string, unknown> = Array.isArray(obj)
    ? ([] as unknown as Record<string, unknown>)
    : {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (VAULT_FIELDS_TO_STRIP.includes(k.toLowerCase())) {
      out[k] = "[REDACTED]";
    } else if (k.toLowerCase() === "email" && typeof v === "string") {
      out[k] = hashEmail(v);
    } else if (typeof v === "object") {
      out[k] = scrubObject(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Smart-strip free-text strings (exception messages, event.message, the route
 * tag) before egress: redact emails, [[wikilinks]], and filesystem-path-like
 * tokens (e.g. Projects/My Idea.md) while keeping the surrounding text so the
 * error stays diagnosable. Path fragments that match none of these patterns
 * may remain — the high-volume content path (request bodies) is handled
 * separately and more aggressively by scrubObject's key-based redaction.
 */
function scrubMessage(input: unknown): unknown {
  if (typeof input !== "string") return input;
  return input
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED]")
    .replace(/\[\[[^\]]*\]\]/g, "[REDACTED]")
    .replace(/(?:[\w .\-]+[/\\])+[\w .\-]+\.[A-Za-z0-9]+/g, "[REDACTED]")
    .replace(/\b[\w .\-]+\.(?:md|markdown)\b/gi, "[REDACTED]");
}

/**
 * Sentry beforeSend hook — last line of defense before an event leaves the
 * process for the third-party Sentry SaaS. Extracted as a named export so it
 * can be unit-tested directly (see tests/observability/sentry.test.ts), the
 * same pattern as scrubTelemetryEvent in tool-telemetry-scrub.ts.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  // The thrown error message can echo a vault path / wikilink / email verbatim
  // (e.g. a Postgres unique-constraint error naming a vault_path). Smart-strip
  // it while keeping the structural text that says WHAT broke.
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (typeof ex.value === "string")
        ex.value = scrubMessage(ex.value) as string;
    }
  }
  if (typeof event.message === "string")
    event.message = scrubMessage(event.message) as string;
  if (event.request?.data)
    event.request.data = scrubObject(event.request.data) as Record<
      string,
      unknown
    >;
  // Secrets the SDK may auto-attach to the request context: Authorization
  // bearer tokens live in headers; session tokens in cookies. Neither has any
  // diagnostic value — drop both outright.
  if (event.request) {
    delete event.request.headers;
    delete event.request.cookies;
  }
  if (event.contexts?.response) {
    delete (event.contexts.response as Record<string, unknown>).data;
  }
  if (event.user?.email) event.user.email = hashEmail(event.user.email);
  // Safety net for the route tag (set at the capture site) — should already be
  // a static template, but scrub in case a raw path fragment reaches it.
  if (event.tags && typeof event.tags.route === "string") {
    event.tags.route = scrubMessage(event.tags.route) as string;
  }
  return event;
}

export function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log("[sentry] SENTRY_DSN not set, Sentry disabled");
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    release: process.env.RAILWAY_GIT_COMMIT_SHA ?? "unknown",
    tracesSampleRate: 0,
    beforeSend: scrubEvent,
  });
  console.log("[sentry] initialized");
}

export { Sentry };
