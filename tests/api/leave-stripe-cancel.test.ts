/**
 * PR #5 (S05) — /api/leave must cancel the workspace's Stripe subscription
 * (cancel_at_period_end: true) BEFORE nuking the cloud mirror. Stripe failure
 * is fail-closed: surface 500, do NOT nuke, user retries.
 *
 * Strategy: mount firstWowRouter with auth-middleware bypassed; mock the
 * Supabase client to return a configurable workspace_subscriptions row; mock
 * Stripe so we can observe subscriptions.update calls; mock nukeWorkspace so
 * we can assert ordering + skip-on-failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";

const WS_ID = "ws-leave-stripe";
const USER_ID = "user-leave-stripe";

// ── Mocks ──────────────────────────────────────────────────────────────────

// Bypass requireSupabaseAuth + requireWorkspace; stamp req.user + req.membership.
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

// Mock nukeWorkspace so we can assert it WAS or WAS NOT called.
const nukeWorkspaceSpy = vi.fn().mockResolvedValue({
  objectCount: 0,
  fileRowCount: 0,
});
vi.mock("../../src/utils/supabase-mirror.js", () => ({
  nukeWorkspace: nukeWorkspaceSpy,
}));

// backend-cache evict — no-op spy.
const evictSpy = vi.fn();
vi.mock("../../src/utils/backend-cache.js", () => ({
  evict: evictSpy,
  getBackend: vi.fn(),
}));

// Stripe — capture calls to subscriptions.update.
const stripeUpdateSpy = vi.fn().mockResolvedValue({});
vi.mock("stripe", () => {
  const StripeClass = vi.fn().mockImplementation(() => ({
    subscriptions: { update: stripeUpdateSpy },
  }));
  return { default: StripeClass };
});

// Supabase — configurable workspace_subscriptions row.
let subscriptionRow: {
  workspace_id: string;
  stripe_subscription_id: string | null;
  status: string;
} | null = {
  workspace_id: WS_ID,
  stripe_subscription_id: "sub_test_leave",
  status: "active",
};

vi.mock("../../src/api/supabase.js", () => ({
  supabaseService: () => ({
    from: (table: string) => {
      if (table === "workspace_subscriptions") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: subscriptionRow,
                error: null,
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected from(${table})`);
    },
  }),
}));

const { firstWowRouter } = await import("../../src/api/first-wow.js");

function makeApp(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use("/api", firstWowRouter());
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("/api/leave — Stripe cancel before nuke (PR #5 / S05)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    stripeUpdateSpy.mockClear();
    stripeUpdateSpy.mockResolvedValue({});
    nukeWorkspaceSpy.mockClear();
    nukeWorkspaceSpy.mockResolvedValue({ objectCount: 0, fileRowCount: 0 });
    evictSpy.mockClear();
    subscriptionRow = {
      workspace_id: WS_ID,
      stripe_subscription_id: "sub_test_leave",
      status: "active",
    };
    ({ server, baseUrl } = await makeApp());
  });

  afterEach(() => server.close());

  it("calls stripe.subscriptions.update with cancel_at_period_end:true BEFORE nukeWorkspace", async () => {
    const r = await fetch(`${baseUrl}/api/leave`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(stripeUpdateSpy).toHaveBeenCalledOnce();
    expect(stripeUpdateSpy).toHaveBeenCalledWith("sub_test_leave", {
      cancel_at_period_end: true,
    });
    expect(nukeWorkspaceSpy).toHaveBeenCalledOnce();
    // Ordering: Stripe was called BEFORE the nuke.
    expect(stripeUpdateSpy.mock.invocationCallOrder[0]).toBeLessThan(
      nukeWorkspaceSpy.mock.invocationCallOrder[0],
    );
  });

  it("returns 500 + skips nukeWorkspace when Stripe throws", async () => {
    stripeUpdateSpy.mockRejectedValueOnce(new Error("stripe api 500"));
    const r = await fetch(`${baseUrl}/api/leave`, { method: "POST" });
    expect(r.status).toBe(500);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("stripe_cancel_failed");
    expect(nukeWorkspaceSpy).not.toHaveBeenCalled();
  });

  it("skips Stripe call entirely when there is no stripe_subscription_id (free trialing user)", async () => {
    subscriptionRow = {
      workspace_id: WS_ID,
      stripe_subscription_id: null,
      status: "trialing",
    };
    const r = await fetch(`${baseUrl}/api/leave`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(stripeUpdateSpy).not.toHaveBeenCalled();
    expect(nukeWorkspaceSpy).toHaveBeenCalledOnce();
  });

  it("idempotent on already-canceled sub — no extra Stripe call, nuke still runs", async () => {
    subscriptionRow = {
      workspace_id: WS_ID,
      stripe_subscription_id: "sub_already_canceled",
      status: "canceled",
    };
    const r = await fetch(`${baseUrl}/api/leave`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(stripeUpdateSpy).not.toHaveBeenCalled();
    expect(nukeWorkspaceSpy).toHaveBeenCalledOnce();
  });
});
