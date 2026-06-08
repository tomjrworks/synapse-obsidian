import { describe, it, expect } from "vitest";
import type { ErrorEvent } from "@sentry/node";
import { scrubEvent } from "../../src/observability/sentry.js";

// H1 — Sentry egress scrub. beforeSend (exported as scrubEvent) is the last
// line of defense before an event leaves the process for the third-party
// Sentry SaaS. These tests pin the redaction guarantee so a refactor can't
// silently reintroduce a leak.

const VAULT_PATH = "Projects/My Secret Idea.md";
const WIKILINK = "[[Daily/2026-06-08 standup]]";
const EMAIL = "tom@taproothq.com";

function baseEvent(): ErrorEvent {
  return { type: undefined } as ErrorEvent;
}

describe("scrubEvent — exception message (smart strip)", () => {
  it("redacts a vault path embedded in the thrown error message", () => {
    const event = baseEvent();
    event.exception = {
      values: [
        {
          type: "PostgresError",
          value: `duplicate key violates unique constraint — Key (vault_path)=(${VAULT_PATH}) already exists`,
        },
      ],
    };

    const out = scrubEvent(event);
    const value = out.exception?.values?.[0]?.value ?? "";

    // private path gone…
    expect(value).not.toContain(VAULT_PATH);
    expect(value).not.toContain("My Secret Idea");
    // …but the structural message that tells us WHAT broke is kept
    expect(value).toContain("duplicate key violates unique constraint");
    expect(value).toContain("[REDACTED]");
  });

  it("redacts emails and [[wikilinks]] in the error message", () => {
    const event = baseEvent();
    event.exception = {
      values: [
        {
          type: "Error",
          value: `failed to sync ${WIKILINK} for user ${EMAIL}`,
        },
      ],
    };

    const value = scrubEvent(event).exception?.values?.[0]?.value ?? "";
    expect(value).not.toContain(EMAIL);
    expect(value).not.toContain(WIKILINK);
    expect(value).not.toContain("standup");
    expect(value).toContain("failed to sync");
  });

  it("scrubs the top-level event.message too (captureMessage path)", () => {
    const event = baseEvent();
    event.message = `note ${VAULT_PATH} not found for ${EMAIL}`;
    const out = scrubEvent(event);
    expect(out.message).not.toContain(VAULT_PATH);
    expect(out.message).not.toContain(EMAIL);
  });

  it("leaves a clean message untouched", () => {
    const event = baseEvent();
    event.exception = {
      values: [{ type: "Error", value: "Connection timeout after 30000ms" }],
    };
    const value = scrubEvent(event).exception?.values?.[0]?.value ?? "";
    expect(value).toBe("Connection timeout after 30000ms");
  });
});

describe("scrubEvent — request secrets", () => {
  it("deletes request.headers (Authorization bearer lives there)", () => {
    const event = baseEvent();
    event.request = {
      method: "POST",
      url: "https://connect.taproothq.com/mcp",
      headers: { authorization: "Bearer sk-secret-token-value" },
    };
    const out = scrubEvent(event);
    expect(out.request?.headers).toBeUndefined();
  });

  it("deletes request.cookies", () => {
    const event = baseEvent();
    event.request = {
      method: "POST",
      url: "https://connect.taproothq.com/mcp",
      cookies: { session: "secret-session" },
    };
    const out = scrubEvent(event);
    expect(out.request?.cookies).toBeUndefined();
  });
});

describe("scrubEvent — tags.route safety net", () => {
  it("scrubs a path-like fragment that lands in the route tag", () => {
    const event = baseEvent();
    event.tags = { route: `/api/${VAULT_PATH}`, workspaceId: "ws-uuid-123" };
    const out = scrubEvent(event);
    expect(out.tags?.route).not.toContain(VAULT_PATH);
    // workspaceId is an internal id, not user content — must be preserved
    expect(out.tags?.workspaceId).toBe("ws-uuid-123");
  });

  it("leaves a normalized route template untouched", () => {
    const event = baseEvent();
    event.tags = { route: "/api/feedback" };
    expect(scrubEvent(event).tags?.route).toBe("/api/feedback");
  });
});

describe("scrubEvent — existing redaction preserved (regression)", () => {
  it("redacts vault fields in request.data and hashes email", () => {
    const event = baseEvent();
    event.request = {
      method: "POST",
      url: "https://connect.taproothq.com/api/feedback",
      data: { content: "my private note body", email: EMAIL, ok: true },
    };
    const data = scrubEvent(event).request?.data as Record<string, unknown>;
    expect(data.content).toBe("[REDACTED]");
    expect(data.email).not.toBe(EMAIL);
    expect(data.email).not.toContain("@");
    expect(data.ok).toBe(true);
  });

  it("deletes contexts.response.data and hashes user.email", () => {
    const event = baseEvent();
    event.contexts = {
      response: { data: { secret: "x" } },
    } as ErrorEvent["contexts"];
    event.user = { email: EMAIL };
    const out = scrubEvent(event);
    expect(
      (out.contexts?.response as Record<string, unknown> | undefined)?.data,
    ).toBeUndefined();
    expect(out.user?.email).not.toBe(EMAIL);
    expect(out.user?.email).not.toContain("@");
  });
});
