/**
 * M1-b — POST /signin/exchange must persist user_id to oauth_tokens.
 *
 * Helper-mac direct-login tokens minted via signin.ts were not user_id-bound,
 * so the password-change revoke trigger (migration 0033) silently skips them
 * (WHERE user_id = NEW.id AND revoked_at IS NULL — NULL user_id rows are
 * invisible to the trigger). A compromised helper-mac bearer stays live for
 * the full 30-day TTL after a password reset.
 *
 * Strategy: drive the full /signin → /signin/exchange flow with mocked
 * Supabase (auth + DB); capture the oauth_tokens insert payload; assert
 * user_id is present. RED on current code (no user_id in insert). GREEN
 * after adding `user_id: entry.userId` at signin.ts:474.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";

const TEST_USER_ID = "user-m1b-test-uuid";
const TEST_WORKSPACE_ID = "ws-m1b-test";

let tokenInsertPayload: Record<string, unknown> | null = null;

vi.mock("../../src/api/supabase.js", () => {
  const makeChain = (onInsert?: (payload: unknown) => void) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      insert: (payload: unknown) => {
        onInsert?.(payload);
        return Promise.resolve({ error: null });
      },
      upsert: () => Promise.resolve({ error: null }),
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      gt: () => chain,
      maybeSingle: async () => ({ data: null, error: null }),
      update: () => chain,
      then: (resolve: (v: unknown) => unknown) => resolve({ error: null }),
    });
    return chain;
  };

  return {
    supabaseService: () => ({
      from: (table: string) => {
        if (table === "oauth_tokens") {
          return makeChain((p) => {
            tokenInsertPayload = p as Record<string, unknown>;
          });
        }
        return makeChain();
      },
      auth: {
        signInWithPassword: async () => ({
          data: { user: { id: TEST_USER_ID } },
          error: null,
        }),
      },
    }),
  };
});

vi.mock("../../src/api/workspace.js", () => ({
  getMembershipForUser: async () => ({
    workspaceId: TEST_WORKSPACE_ID,
    role: "owner",
  }),
}));

const { registerSigninRoutes } = await import("../../src/signin.js");

function makeApp(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    registerSigninRoutes(app, "http://localhost");
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const { randomBytes, createHash } = await import("node:crypto");
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

describe("POST /signin/exchange — user_id binding (M1-b)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    tokenInsertPayload = null;
    ({ server, baseUrl } = await makeApp());
  });

  afterEach(() => server.close());

  it("persists user_id to oauth_tokens on signin exchange", async () => {
    const { verifier, challenge } = await pkce();

    // Step 1: POST /signin — credentials + PKCE challenge.
    // Supabase auth is mocked to return TEST_USER_ID.
    const signinRes = await fetch(`${baseUrl}/signin`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "test@example.com",
        password: "password123",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
      redirect: "manual",
    });

    // Expect redirect to taproot://auth?code=...
    expect(signinRes.status).toBe(302);
    const location = signinRes.headers.get("location") ?? "";
    expect(location).toMatch(/^taproot:\/\/auth/);

    const deepLink = new URL(location);
    const code = deepLink.searchParams.get("code");
    expect(code).toBeTruthy();

    // Step 2: POST /signin/exchange — prove PKCE possession, mint bearer.
    const exchangeRes = await fetch(`${baseUrl}/signin/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier }),
    });

    expect(exchangeRes.status).toBe(200);
    const body = (await exchangeRes.json()) as Record<string, unknown>;
    expect(body.bearer).toBeTruthy();

    // M1-b assertion: user_id must be in the oauth_tokens insert payload.
    expect(tokenInsertPayload).not.toBeNull();
    expect(tokenInsertPayload).toMatchObject({ user_id: TEST_USER_ID });
  });
});
