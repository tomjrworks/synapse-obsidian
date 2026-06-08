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
 * Sentry beforeSend hook — last line of defense before an event leaves the
 * process for the third-party Sentry SaaS. Extracted as a named export so it
 * can be unit-tested directly (see tests/observability/sentry.test.ts), the
 * same pattern as scrubTelemetryEvent in tool-telemetry-scrub.ts.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request?.data)
    event.request.data = scrubObject(event.request.data) as Record<
      string,
      unknown
    >;
  if (event.contexts?.response) {
    delete (event.contexts.response as Record<string, unknown>).data;
  }
  if (event.user?.email) event.user.email = hashEmail(event.user.email);
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
