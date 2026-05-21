/**
 * PR #5 (S04) — DELETE /api/account is the GDPR / right-to-erasure path.
 * Cascade (FK-locked by workspaces.owner_user_id ON DELETE RESTRICT):
 *
 *   1. Find all workspaces.owner_user_id = user.id
 *   2. For each: Stripe cancel → nukeWorkspace → account_delete audit →
 *      DELETE FROM workspaces → evict
 *   3. supabase.auth.admin.deleteUser(user.id)
 *
 * Failure modes:
 *   - Stripe error mid-cascade → 500, NO workspace deleted, NO auth delete
 *   - auth.admin.deleteUser error → 500 + workspaces_purged in body
 *
 * Audit log: one vault_nuke + one account_delete per workspace.
 * Rate limit: 3/hour/user (4th → 429).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";

const USER_ID = "user-account-delete";

// ── Mocks ──────────────────────────────────────────────────────────────────

// Bypass requireSupabaseAuth + requireWorkspace; preserve userIdLimitMiddleware
// so the rate-limit test exercises the real limiter.
vi.mock("../../src/api/middleware.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/api/middleware.js")>();
  const passAuth: express.RequestHandler = (req, _res, next) => {
    (req as Record<string, unknown>).user = { id: USER_ID };
    next();
  };
  const passWorkspace: express.RequestHandler = (req, _res, next) => {
    (req as Record<string, unknown>).membership = {
      workspaceId: "ws-irrelevant-account-delete",
    };
    next();
  };
  return {
    ...actual,
    requireSupabaseAuth: passAuth,
    requireWorkspace: passWorkspace,
  };
});

// nukeWorkspace spy.
const nukeWorkspaceSpy = vi.fn().mockResolvedValue({
  objectCount: 0,
  fileRowCount: 0,
});
vi.mock("../../src/utils/supabase-mirror.js", () => ({
  nukeWorkspace: nukeWorkspaceSpy,
}));

// backend-cache evict spy.
const evictSpy = vi.fn();
vi.mock("../../src/utils/backend-cache.js", () => ({
  evict: evictSpy,
  getBackend: vi.fn(),
}));

// Stripe spy.
const stripeUpdateSpy = vi.fn().mockResolvedValue({});
vi.mock("stripe", () => {
  const StripeClass = vi.fn().mockImplementation(() => ({
    subscriptions: { update: stripeUpdateSpy },
  }));
  return { default: StripeClass };
});

// Supabase mock — workspace_subscriptions row, workspaces lookup/delete,
// audit_log inserts, auth.admin.deleteUser. Table-aware.
interface AuditRow {
  workspace_id: string;
  operation: string;
  user_id: string | null;
  details: unknown;
}

let ownedWorkspaces: { id: string }[] = [];
let subscriptionRowFor: (ws: string) => {
  workspace_id: string;
  stripe_subscription_id: string | null;
  status: string;
} | null;
const auditRows: AuditRow[] = [];
const deletedWorkspaceIds: string[] = [];
const adminDeleteUserSpy = vi.fn().mockResolvedValue({ error: null });

vi.mock("../../src/api/supabase.js", () => ({
  supabaseService: () => ({
    from: (table: string) => {
      if (table === "workspaces") {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: ownedWorkspaces, error: null }),
          }),
          delete: () => ({
            eq: (_col: string, val: string) => {
              deletedWorkspaceIds.push(val);
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      if (table === "workspace_subscriptions") {
        return {
          select: () => ({
            eq: (_col: string, val: string) => ({
              maybeSingle: async () => ({
                data: subscriptionRowFor(val),
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "audit_log") {
        return {
          insert: (row: AuditRow) => {
            auditRows.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected from(${table})`);
    },
    auth: {
      admin: { deleteUser: adminDeleteUserSpy },
    },
  }),
}));

const { accountRouter } = await import("../../src/api/account.js");

function makeApp(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use("/api", accountRouter());
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("DELETE /api/account — full account erasure (PR #5 / S04)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    stripeUpdateSpy.mockClear();
    stripeUpdateSpy.mockResolvedValue({});
    nukeWorkspaceSpy.mockClear();
    nukeWorkspaceSpy.mockResolvedValue({ objectCount: 0, fileRowCount: 0 });
    evictSpy.mockClear();
    adminDeleteUserSpy.mockClear();
    adminDeleteUserSpy.mockResolvedValue({ error: null });
    auditRows.length = 0;
    deletedWorkspaceIds.length = 0;
    ownedWorkspaces = [{ id: "ws-acc-1" }];
    subscriptionRowFor = (ws) => ({
      workspace_id: ws,
      stripe_subscription_id: "sub_acc",
      status: "active",
    });
    ({ server, baseUrl } = await makeApp());
  });

  afterEach(() => server.close());

  it("happy path: 1-workspace user → cancel → nuke → ws delete → auth delete → 200", async () => {
    const r = await fetch(`${baseUrl}/api/account`, { method: "DELETE" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ deleted: true, workspaces_purged: 1 });

    // Cascade ran end-to-end.
    expect(stripeUpdateSpy).toHaveBeenCalledOnce();
    expect(nukeWorkspaceSpy).toHaveBeenCalledOnce();
    expect(deletedWorkspaceIds).toEqual(["ws-acc-1"]);
    expect(adminDeleteUserSpy).toHaveBeenCalledOnce();
    expect(adminDeleteUserSpy).toHaveBeenCalledWith(USER_ID);
    expect(evictSpy).toHaveBeenCalledWith("ws-acc-1");

    // Ordering: stripe → nuke → ws delete → auth delete.
    expect(stripeUpdateSpy.mock.invocationCallOrder[0]).toBeLessThan(
      nukeWorkspaceSpy.mock.invocationCallOrder[0],
    );
    expect(nukeWorkspaceSpy.mock.invocationCallOrder[0]).toBeLessThan(
      adminDeleteUserSpy.mock.invocationCallOrder[0],
    );
  });

  it("Stripe failure on workspace #1 → no workspace deleted, no auth delete, 500", async () => {
    stripeUpdateSpy.mockRejectedValueOnce(new Error("stripe api 500"));
    const r = await fetch(`${baseUrl}/api/account`, { method: "DELETE" });
    expect(r.status).toBe(500);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("stripe_cancel_failed");

    expect(nukeWorkspaceSpy).not.toHaveBeenCalled();
    expect(deletedWorkspaceIds).toEqual([]);
    expect(adminDeleteUserSpy).not.toHaveBeenCalled();
  });

  it("auth.admin.deleteUser failure after workspaces gone → 500 + workspaces_purged in body", async () => {
    adminDeleteUserSpy.mockResolvedValueOnce({
      error: { message: "boom", name: "AuthError" },
    });
    const r = await fetch(`${baseUrl}/api/account`, { method: "DELETE" });
    expect(r.status).toBe(500);
    const body = (await r.json()) as {
      error: string;
      workspaces_purged: number;
    };
    expect(body.error).toBe("auth_user_delete_failed");
    // Workspaces were deleted before the auth-delete failure surfaced.
    expect(body.workspaces_purged).toBe(1);
    expect(deletedWorkspaceIds).toEqual(["ws-acc-1"]);
  });

  it("emits one vault_nuke + one account_delete audit row per workspace", async () => {
    ownedWorkspaces = [{ id: "ws-acc-A" }, { id: "ws-acc-B" }];
    const r = await fetch(`${baseUrl}/api/account`, { method: "DELETE" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ deleted: true, workspaces_purged: 2 });

    // account_delete audit rows are inserted directly via the supabase mock
    // (one per workspace). vault_nuke audit rows are emitted inside the
    // (mocked) nukeWorkspace — assert nukeWorkspace was called per workspace.
    expect(nukeWorkspaceSpy).toHaveBeenCalledTimes(2);
    const accountDeletes = auditRows.filter(
      (r) => r.operation === "account_delete",
    );
    expect(accountDeletes).toHaveLength(2);
    expect(accountDeletes.map((r) => r.workspace_id).sort()).toEqual([
      "ws-acc-A",
      "ws-acc-B",
    ]);
    accountDeletes.forEach((r) => expect(r.user_id).toBe(USER_ID));
  });

  it("4th call within an hour → 429 (rate-limited at 3/hour/user)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${baseUrl}/api/account`, { method: "DELETE" });
      statuses.push(r.status);
      // Re-seed because owner lookup pulls fresh.
      ownedWorkspaces = [{ id: `ws-acc-${i + 1}` }];
    }
    // First 3 must pass the limiter; 4th must be 429.
    expect(statuses.slice(0, 3).every((s) => s !== 429)).toBe(true);
    expect(statuses[3]).toBe(429);
  });
});
