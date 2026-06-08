/**
 * M1 (Pass-5 audit) — POST /token must persist user_id to oauth_tokens.
 *
 * Without user_id, a password-reset → token-revoke hook can't target the
 * right rows; a compromised bearer stays live for the full 30-day TTL after
 * the user "secures" their account.
 *
 * Strategy: stub authCodes so the exchange skips the in-memory LRU (the code
 * is pre-loaded into the real authCodes map via the exported helper); mock
 * supabaseService so the oauth_clients + oauth_tokens inserts are captured
 * without a real DB; assert that the oauth_tokens insert payload includes
 * user_id.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";

const TEST_USER_ID = "user-m1-test";
const TEST_WORKSPACE_ID = "ws-m1-test";
const TEST_CLIENT_ID = "client-m1-test";

// Capture the payload passed to oauth_tokens.insert().
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
        // oauth_clients upsert — inert
        return makeChain();
      },
    }),
  };
});

// Import registerOAuthRoutes AFTER the mock is registered.
const { registerOAuthRoutes } = await import("../../src/oauth.js");

// We need to pre-populate the authCodes LRU that lives inside oauth.ts.
// The module doesn't export it, but we can run a real /authorize POST against
// the test server — too involved for a unit eval. Instead, expose a small
// test helper via a second mock-free import of oauth.ts that we control.
//
// Simpler: we drive the /token endpoint via HTTP and forge the auth-code by
// calling the module's internal LRU directly through a thin re-export shim.
// Since authCodes is module-private, we use a different strategy: hit the
// full /authorize flow with a mocked Supabase auth.signInWithPassword.

// Mock supabase auth.signInWithPassword so /authorize POST works.
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

function makeApp(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    registerOAuthRoutes(app, "http://localhost");
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

// PKCE helpers
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

describe("POST /token — user_id binding (M1)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    tokenInsertPayload = null;
    ({ server, baseUrl } = await makeApp());

    // Register a client so /authorize GET has a known pendingClient.
    const reg = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "TestClient",
        redirect_uris: ["http://localhost/cb"],
      }),
    });
    const regBody = (await reg.json()) as { client_id: string };
    (globalThis as Record<string, unknown>).__testClientId = regBody.client_id;
  });

  afterEach(() => server.close());

  it("persists user_id to oauth_tokens on token exchange", async () => {
    const clientId = (globalThis as Record<string, unknown>)
      .__testClientId as string;
    const redirectUri = "http://localhost/cb";
    const { verifier, challenge } = await pkce();

    // Step 1: GET /authorize to get the request_token + issued_at.
    const getAuth = await fetch(
      `${baseUrl}/authorize?` +
        new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          state: "st",
        }),
      { redirect: "manual" },
    );
    const html = await getAuth.text();

    // Extract hidden fields from the rendered form.
    const requestToken = html.match(
      /name="request_token"\s+value="([^"]+)"/,
    )?.[1];
    const issuedAt = html.match(/name="issued_at"\s+value="([^"]+)"/)?.[1];
    expect(requestToken).toBeTruthy();
    expect(issuedAt).toBeTruthy();

    // Step 2: POST /authorize (credential submit) — Supabase auth is mocked.
    const postAuth = await fetch(`${baseUrl}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "st",
        email: "test@example.com",
        password: "password123",
        request_token: requestToken!,
        issued_at: issuedAt!,
      }),
      redirect: "manual",
    });
    const location = postAuth.headers.get("location") ?? "";
    const code = new URL(location, "http://localhost").searchParams.get("code");
    expect(code).toBeTruthy();

    // Step 3: POST /token — exchange code for bearer.
    const tokenRes = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      }),
    });

    expect(tokenRes.status).toBe(200);

    // M1 assertion: user_id must be in the oauth_tokens insert payload.
    expect(tokenInsertPayload).not.toBeNull();
    expect(tokenInsertPayload).toMatchObject({ user_id: TEST_USER_ID });
  });
});
