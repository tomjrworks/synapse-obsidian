import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Tests for H2 fix: /api/me trimmed to {workspace_name}; identity surface
// moved to /api/dashboard/me (Supabase-JWT only).
// ---------------------------------------------------------------------------

vi.mock("../../src/api/middleware.js", () => ({
  requireOAuthAuth: vi.fn((_req: unknown, _res: unknown, next: () => void) =>
    next(),
  ),
  requireOAuthWorkspace: vi.fn(
    (req: unknown, _res: unknown, next: () => void) => {
      (req as Record<string, unknown>).membership = {
        workspaceId: "ws-test",
        name: "Test Workspace",
        userId: "user-test",
        settings: {
          onboarding_step: "done",
          persona: { traits: ["founder"], freetext: "builds stuff" },
          connected_clients: ["claude"],
        },
      };
      (req as Record<string, unknown>).user = {
        id: "user-test",
        email: "test@example.com",
      };
      next();
    },
  ),
  requireSupabaseAuth: vi.fn(
    (req: unknown, _res: unknown, next: () => void) => {
      (req as Record<string, unknown>).user = {
        id: "user-test",
        email: "test@example.com",
      };
      next();
    },
  ),
  requireWorkspace: vi.fn((req: unknown, _res: unknown, next: () => void) => {
    (req as Record<string, unknown>).membership = {
      workspaceId: "ws-test",
      name: "Test Workspace",
      userId: "user-test",
      settings: {
        onboarding_step: "done",
        persona: { traits: ["founder"], freetext: "builds stuff" },
        connected_clients: ["claude"],
      },
    };
    next();
  }),
  asyncHandler: vi.fn(
    (fn: (req: unknown, res: unknown, next: () => void) => Promise<void>) => fn,
  ),
}));

import {
  requireOAuthAuth,
  requireSupabaseAuth,
} from "../../src/api/middleware.js";
import { meRouter } from "../../src/api/me.js";
import { dashboardRouter } from "../../src/api/dashboard.js";

function makeRes() {
  const res = {
    _json: null as unknown,
    _status: 200,
    json: vi.fn(function (this: ReturnType<typeof makeRes>, body: unknown) {
      this._json = body;
      return this;
    }),
    status: vi.fn(function (this: ReturnType<typeof makeRes>, code: number) {
      this._status = code;
      return this;
    }),
  };
  res.json = res.json.bind(res);
  res.status = res.status.bind(res);
  return res;
}

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    path: "",
    method: "GET",
    url: "",
    header: vi.fn(() => "Bearer fake-token"),
    ...overrides,
  };
}

async function callRouter(
  router: ReturnType<typeof meRouter>,
  path: string,
  req: ReturnType<typeof makeReq>,
  res: ReturnType<typeof makeRes>,
) {
  await new Promise<void>((resolve) => {
    (router as unknown as { handle: Function }).handle(
      Object.assign(req, { path, method: "GET", url: path }),
      res,
      () => resolve(),
    );
    setTimeout(resolve, 50);
  });
}

beforeEach(() => {
  vi.mocked(requireOAuthAuth).mockImplementation(
    (_req: unknown, _res: unknown, next: () => void) => next(),
  );
  vi.mocked(requireSupabaseAuth).mockImplementation(
    (req: unknown, _res: unknown, next: () => void) => {
      (req as Record<string, unknown>).user = {
        id: "user-test",
        email: "test@example.com",
      };
      next();
    },
  );
});

describe("GET /api/me (H2 trim)", () => {
  it("returns exactly {workspace_name} — 1 key, no extras", async () => {
    const req = makeReq();
    const res = makeRes();
    await callRouter(meRouter(), "/me", req, res);

    expect(res._json).toEqual({ workspace_name: "Test Workspace" });
    expect(Object.keys(res._json as object)).toHaveLength(1);
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(requireOAuthAuth).mockImplementationOnce(
      (_req: unknown, res: unknown, _next: () => void) => {
        (res as ReturnType<typeof makeRes>)
          .status(401)
          .json({ error: "missing_bearer_token" });
      },
    );

    const req = makeReq();
    const res = makeRes();
    await callRouter(meRouter(), "/me", req, res);

    expect(res._status).toBe(401);
  });
});

describe("GET /api/dashboard/me (H2 new endpoint)", () => {
  it("returns 401 when called with OAuth bearer (wrong auth type)", async () => {
    vi.mocked(requireSupabaseAuth).mockImplementationOnce(
      (_req: unknown, res: unknown, _next: () => void) => {
        (res as ReturnType<typeof makeRes>)
          .status(401)
          .json({ error: "invalid_token" });
      },
    );

    const req = makeReq();
    const res = makeRes();
    await callRouter(dashboardRouter(), "/dashboard/me", req, res);

    expect(res._status).toBe(401);
  });

  it("returns full identity surface with Supabase JWT", async () => {
    const req = makeReq();
    const res = makeRes();
    await callRouter(dashboardRouter(), "/dashboard/me", req, res);

    expect(res._json).toMatchObject({
      user_id: "user-test",
      email: "test@example.com",
      workspace_id: "ws-test",
      workspace_name: "Test Workspace",
      onboarding_step: "done",
      persona_traits: ["founder"],
      persona_freetext: "builds stuff",
      connected_clients: ["claude"],
    });
  });
});
