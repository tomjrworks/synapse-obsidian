/**
 * M1-c (rotation half) — POST /helper/auth/direct on an EXISTING device rotates
 * the bearer via an UPDATE (not an insert), and that UPDATE must also set
 * user_id. A helper token that began life as a NULL-user_id row (minted before
 * M1-c) would otherwise stay NULL across rotation and keep escaping the 0033
 * password-change revoke trigger.
 *
 * The insert path is covered in helper-bearer-user-id.test.ts; this locks the
 * subtler UPDATE branch + the /helper/auth/direct call site (req.user.id).
 *
 * Strategy: bypass requireSupabaseAuth/requireWorkspace (stamp req.user +
 * req.membership), make the helper_devices lookup return an EXISTING device so
 * mintHelperBearer takes the rotation branch, capture the oauth_tokens UPDATE
 * payload, assert user_id == the authed user's id.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";

const WS_ID = "ws-m1c-rot";
const USER_ID = "user-m1c-rot-uuid";

let tokenUpdatePayload: Record<string, unknown> | null = null;

// Bypass auth: stamp the authed user + workspace membership the route reads.
vi.mock("../../src/api/middleware.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/api/middleware.js")>();
  const passAuth: express.RequestHandler = (req, _res, next) => {
    (req as Record<string, unknown>).user = { id: USER_ID };
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

vi.mock("../../src/api/supabase.js", () => {
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      order: () => chain,
      limit: () => chain,
      upsert: () => Promise.resolve({ error: null }),
      update: (payload: unknown) => {
        if (table === "oauth_tokens") {
          tokenUpdatePayload = payload as Record<string, unknown>;
        }
        return chain;
      },
      insert: () => chain,
      single: async () => ({ data: { id: "dev-existing" }, error: null }),
      // helper_devices: both the existing-device lookup and the post-update
      // re-read return a device row (handler only reads .id from the update).
      maybeSingle: async () => {
        if (table === "helper_devices") {
          return {
            data: { id: "dev-existing", device_secret_hash: "\\xoldhash" },
            error: null,
          };
        }
        return { data: null, error: null };
      },
      // oauth_tokens UPDATE is awaited after .is(); resolve to no-error.
      then: (resolve: (v: unknown) => unknown) => resolve({ error: null }),
    });
    return chain;
  };
  return {
    supabaseService: () => ({ from: (table: string) => chainFor(table) }),
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

describe("POST /helper/auth/direct — user_id on rotation UPDATE (M1-c)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    tokenUpdatePayload = null;
    ({ server, baseUrl } = await makeApp());
  });

  afterEach(() => server.close());

  it("sets user_id in the oauth_tokens UPDATE when rotating an existing device", async () => {
    const res = await fetch(`${baseUrl}/api/helper/auth/direct`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_name: "Test Mac", os_platform: "macOS" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.bearer).toBeTruthy();
    expect(body.workspace_id).toBe(WS_ID);

    // M1-c: the rotation UPDATE must carry user_id (the authed user), so a
    // pre-M1-c NULL row gets backfilled on rotate.
    expect(tokenUpdatePayload).not.toBeNull();
    expect(tokenUpdatePayload).toMatchObject({ user_id: USER_ID });
  });
});
