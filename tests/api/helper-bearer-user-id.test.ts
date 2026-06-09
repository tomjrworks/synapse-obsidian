/**
 * M1-c — helper-mac bearer mint (mintHelperBearer) must persist user_id to
 * oauth_tokens.
 *
 * The pairing + direct-auth flows mint long-lived device bearers via
 * mintHelperBearer (src/api/helper.ts:79). That insert omitted user_id, so the
 * password-change revoke trigger (migration 0033 — WHERE user_id = NEW.id)
 * silently skips every helper bearer: a compromised device token survives a
 * password reset for the full 30-day TTL. This is the same gap M1 (oauth.ts)
 * and M1-b (signin.ts) closed on the other two mint paths — helper.ts is the
 * third and most-used one.
 *
 * The owning user's id IS available at both call sites:
 *   - /helper/pair/redeem: pairRow.user_id (helper.ts:260), populated at
 *     pair-token mint from authed.user.id (helper.ts:215).
 *   - /helper/auth/direct: req.user.id via requireSupabaseAuth (middleware.ts:49).
 *
 * Strategy: drive POST /api/helper/pair/redeem with mocked Supabase. The
 * pair_tokens lookup returns a row carrying user_id; capture the oauth_tokens
 * insert payload; assert user_id is present and equals the pair row's user_id.
 * RED on current code (no user_id threaded into the insert). GREEN after the fix.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { generatePairToken } from "../../src/lib/pair-token.js";

const WS_ID = "ws-m1c-test";
const USER_ID = "user-m1c-test-uuid";

let tokenInsertPayload: Record<string, unknown> | null = null;

vi.mock("../../src/api/supabase.js", () => {
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      gt: () => chain,
      order: () => chain,
      limit: () => chain,
      update: () => chain,
      upsert: () => Promise.resolve({ error: null }),
      insert: (payload: unknown) => {
        if (table === "oauth_tokens") {
          tokenInsertPayload = payload as Record<string, unknown>;
        }
        return chain;
      },
      // helper_devices: .insert(...).select("id").single()
      single: async () => ({ data: { id: "dev-m1c" }, error: null }),
      // pair_tokens initial lookup: .select(...).eq(...).maybeSingle()
      maybeSingle: async () => {
        if (table === "pair_tokens") {
          return {
            data: {
              workspace_id: WS_ID,
              user_id: USER_ID,
              consumed_at: null,
              expires_at: new Date(Date.now() + 60_000).toISOString(),
            },
            error: null,
          };
        }
        return { data: null, error: null };
      },
      // Awaited terminals:
      //  - oauth_tokens insert / oauth_clients upsert → { error: null }
      //  - pair_tokens consume: .update().eq().is().select() → { data: [row] }
      then: (resolve: (v: unknown) => unknown) => {
        if (table === "pair_tokens") {
          return resolve({ data: [{ token_hash: "consumed" }], error: null });
        }
        return resolve({ error: null });
      },
    });
    return chain;
  };

  return {
    supabaseService: () => ({
      from: (table: string) => chainFor(table),
    }),
  };
});

const { helperRouter } = await import("../../src/api/helper.js");

function makeApp(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use("/api", helperRouter());
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe("POST /helper/pair/redeem — user_id binding (M1-c)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    tokenInsertPayload = null;
    ({ server, baseUrl } = await makeApp());
  });

  afterEach(() => server.close());

  it("persists user_id to oauth_tokens when minting a helper bearer", async () => {
    const code = generatePairToken();

    const res = await fetch(`${baseUrl}/api/helper/pair/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        device_name: "Test Mac",
        os_platform: "macOS",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.bearer).toBeTruthy();
    expect(body.workspace_id).toBe(WS_ID);

    // M1-c assertion: the oauth_tokens insert must carry the owner's user_id,
    // sourced from the pair_tokens row.
    expect(tokenInsertPayload).not.toBeNull();
    expect(tokenInsertPayload).toMatchObject({ user_id: USER_ID });
  });
});
