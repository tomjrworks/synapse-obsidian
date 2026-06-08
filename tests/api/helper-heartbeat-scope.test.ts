/**
 * M3 (Pass-5 audit / prior finding S14) — PUT /helper/heartbeat must scope its
 * helper_devices UPDATE by workspace_id, not by device_secret_hash alone.
 *
 * No exploit today (the same 256-bit hash is written to both helper_devices and
 * oauth_tokens for one workspace; collision is infeasible) — but the row update
 * is keyed only on the secret hash + revoked_at, so a future token-rotation
 * migration that desynced the tables could touch another workspace's device row.
 * Defense-in-depth: add .eq("workspace_id", workspaceId).
 *
 * Strategy: mount helperRouter with requireOAuthAuth bypassed (stamps
 * req.workspaceId); stub the subscription helpers so the post-update billing
 * path is inert; mock supabaseService with a builder that RECORDS every .eq()
 * applied to the helper_devices update so we can assert the workspace scope.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";

const WS_ID = "ws-heartbeat-m3";

// Bypass requireOAuthAuth; stamp req.workspaceId. Keep asyncHandler real.
vi.mock("../../src/api/middleware.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/api/middleware.js")>();
  const passOAuth: express.RequestHandler = (req, _res, next) => {
    (req as Record<string, unknown>).workspaceId = WS_ID;
    next();
  };
  return { ...actual, requireOAuthAuth: passOAuth };
});

// Inert subscription path so the handler completes without extra sb calls.
vi.mock("../../src/api/subscription.js", () => ({
  getSubscriptionFallback: async () => ({
    status: "active",
    trial_ends_at: null,
    trial_warning_sent_at: null,
  }),
  getDaysRemaining: () => null,
}));

// Record every .eq() applied to the helper_devices update chain.
const eqCalls: Array<[string, unknown]> = [];

vi.mock("../../src/api/supabase.js", () => {
  const helperDevicesChain: Record<string, unknown> = {};
  Object.assign(helperDevicesChain, {
    update: () => helperDevicesChain,
    eq: (col: string, val: unknown) => {
      eqCalls.push([col, val]);
      return helperDevicesChain;
    },
    is: () => helperDevicesChain,
    select: () => helperDevicesChain,
    maybeSingle: async () => ({
      data: { id: "dev-1", last_seen_at: "2026-06-08T00:00:00.000Z" },
      error: null,
    }),
  });
  return {
    supabaseService: () => ({
      from: (table: string) => {
        if (table === "helper_devices") return helperDevicesChain;
        throw new Error(`unexpected from(${table})`);
      },
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

describe("PUT /helper/heartbeat — workspace-scoped device update (M3/S14)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    eqCalls.length = 0;
    ({ server, baseUrl } = await makeApp());
  });

  afterEach(() => server.close());

  it("scopes the helper_devices update by workspace_id", async () => {
    const r = await fetch(`${baseUrl}/api/helper/heartbeat`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-device-token",
      },
      body: JSON.stringify({}),
    });

    expect(r.status).toBe(200);
    // The update must be scoped to the caller's workspace…
    expect(eqCalls).toContainEqual(["workspace_id", WS_ID]);
    // …in ADDITION to the secret-hash filter (not instead of it).
    expect(eqCalls.some(([col]) => col === "device_secret_hash")).toBe(true);
  });
});
