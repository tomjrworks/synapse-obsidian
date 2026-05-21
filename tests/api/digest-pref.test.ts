/**
 * PR #5 (S74) — GET/POST /api/dashboard/digest-pref. Before this, the SITE
 * DigestToggle was pure local React state; user opted out, still got Sunday
 * emails. CAN-SPAM compliance hit.
 *
 * Coverage:
 *   - GET returns the current email_subscribed value
 *   - POST { email_subscribed: false } updates the row + returns the new state
 *   - POST with non-boolean body → 400 invalid_body
 *   - POST with missing body → 400
 *   - Rate limit: 20/hour/workspace, 21st → 429
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";

const WS_ID = "ws-digest-pref";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("../../src/api/middleware.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/api/middleware.js")>();
  const passAuth: express.RequestHandler = (req, _res, next) => {
    (req as Record<string, unknown>).user = { id: "user-digest" };
    next();
  };
  const passWorkspace: express.RequestHandler = (req, _res, next) => {
    (req as Record<string, unknown>).membership = { workspaceId: WS_ID };
    next();
  };
  return {
    ...actual,
    requireSupabaseAuth: passAuth,
    requireWorkspace: passWorkspace,
  };
});

let storedEmailSubscribed = true;
const updateCallSpy = vi.fn();

vi.mock("../../src/api/supabase.js", () => ({
  supabaseService: () => ({
    from: (table: string) => {
      if (table === "digest_preferences") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { email_subscribed: storedEmailSubscribed },
                error: null,
              }),
            }),
          }),
          update: (row: { email_subscribed: boolean }) => {
            updateCallSpy(row);
            storedEmailSubscribed = row.email_subscribed;
            return {
              eq: () => Promise.resolve({ error: null }),
            };
          },
        };
      }
      throw new Error(`unexpected from(${table})`);
    },
  }),
}));

const { digestPrefRouter } = await import("../../src/api/digest-pref.js");

function makeApp(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use("/api", digestPrefRouter());
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("digest-pref endpoints (PR #5 / S74)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    storedEmailSubscribed = true;
    updateCallSpy.mockClear();
    ({ server, baseUrl } = await makeApp());
  });

  afterEach(() => server.close());

  it("GET returns the current email_subscribed value", async () => {
    storedEmailSubscribed = false;
    const r = await fetch(`${baseUrl}/api/dashboard/digest-pref`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ email_subscribed: false });
  });

  it("POST { email_subscribed: false } updates the row and returns the new state", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/digest-pref`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email_subscribed: false }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ email_subscribed: false });
    expect(updateCallSpy).toHaveBeenCalledOnce();
    expect(updateCallSpy.mock.calls[0][0].email_subscribed).toBe(false);
  });

  it('POST { email_subscribed: "no" } → 400 invalid_body', async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/digest-pref`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email_subscribed: "no" }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("invalid_body");
    expect(updateCallSpy).not.toHaveBeenCalled();
  });

  it("POST with missing body → 400", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/digest-pref`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    expect(updateCallSpy).not.toHaveBeenCalled();
  });

  it("21st request within an hour → 429 (workspace rate limit 20/hour)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const r = await fetch(`${baseUrl}/api/dashboard/digest-pref`);
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 20).every((s) => s !== 429)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});
