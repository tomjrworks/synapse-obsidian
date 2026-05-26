import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Discord signup ping (originally S64).
// - Uses dedicated DISCORD_SIGNUPS_WEBHOOK_URL channel (not the Sentry 5xx
//   channel) — defense-in-depth against accidentally posting PII into the
//   shared error channel.
// - Sends the FULL email (unmasked since 2026-05-26). The original S64
//   masking stripped the local-part; reverted because operator outreach to
//   new signups requires the full email and #taproot-signups is an
//   invite-only solo-operator channel. KEEP THE CHANNEL PRIVATE — adding
//   teammates or contractors re-opens the S64 PII finding.
// ---------------------------------------------------------------------------

const WEBHOOK_URL = "https://discord.test/webhook";
const EXISTING_WORKSPACE_ID = "ws-existing-uuid";

vi.mock("../../src/api/supabase.js", () => ({
  supabaseService: vi.fn(() => ({})),
}));

vi.mock("../../src/api/crypto.js", () => ({
  generateDek: vi.fn(() => Buffer.from("fake-dek")),
  wrapDek: vi.fn(() => Buffer.from("fake-wrapped-dek")),
}));

vi.mock("../../src/api/respond-error.js", () => ({
  respondError: vi.fn(),
}));

const mockUser: { id: string; email: string | undefined } = {
  id: "user-1",
  email: "test@taproothq.com",
};

vi.mock("../../src/api/middleware.js", () => ({
  requireSupabaseAuth: vi.fn(
    (req: unknown, _res: unknown, next: () => void) => {
      (req as Record<string, unknown>).user = mockUser;
      next();
    },
  ),
  userIdLimitMiddleware: vi.fn(
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
  ),
  asyncHandler: vi.fn(
    (fn: (req: unknown, res: unknown, next: () => void) => Promise<void>) => fn,
  ),
}));

const mockGetMembership = vi.fn();
vi.mock("../../src/api/workspace.js", () => ({
  getMembershipForUser: (...args: unknown[]) => mockGetMembership(...args),
}));

import { workspaceCreateRouter } from "../../src/api/workspace-create.js";

function makeRes() {
  const res = {
    _status: 200,
    _json: null as unknown,
    status: vi.fn(function (this: ReturnType<typeof makeRes>, code: number) {
      this._status = code;
      return this;
    }),
    json: vi.fn(function (this: ReturnType<typeof makeRes>, body: unknown) {
      this._json = body;
      return this;
    }),
  };
  res.status = res.status.bind(res);
  res.json = res.json.bind(res);
  return res;
}

async function callWorkspaceCreate(
  req: Record<string, unknown>,
  res: ReturnType<typeof makeRes>,
) {
  const router = workspaceCreateRouter();
  await new Promise<void>((resolve) => {
    (router as unknown as { handle: Function }).handle(
      Object.assign(req, {
        path: "/workspace",
        method: "POST",
        url: "/workspace",
        body: {},
      }),
      res,
      () => resolve(),
    );
    setTimeout(resolve, 100);
  });
  // allow the non-blocking fetch().catch() to settle
  await new Promise((r) => setTimeout(r, 20));
}

async function mockSupabaseSuccess() {
  const { supabaseService } = await import("../../src/api/supabase.js");
  vi.mocked(supabaseService).mockReturnValue({
    rpc: vi.fn().mockResolvedValue({ error: null }),
  } as unknown as ReturnType<typeof supabaseService>);
}

describe("workspace-create Discord signup ping (S64)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalEnv = process.env.DISCORD_SIGNUPS_WEBHOOK_URL;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchSpy);
    process.env.DISCORD_SIGNUPS_WEBHOOK_URL = WEBHOOK_URL;
    mockUser.id = "user-1";
    mockUser.email = "test@taproothq.com";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalEnv === undefined) {
      delete process.env.DISCORD_SIGNUPS_WEBHOOK_URL;
    } else {
      process.env.DISCORD_SIGNUPS_WEBHOOK_URL = originalEnv;
    }
    vi.clearAllMocks();
  });

  it("pings Discord when a new workspace is created (201) with the full email", async () => {
    mockGetMembership.mockResolvedValue(null);
    await mockSupabaseSuccess();

    const res = makeRes();
    const req = {
      user: mockUser,
      body: {},
    };
    await callWorkspaceCreate(req, res);

    expect(res._status).toBe(201);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK_URL);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toMatch(/New signup/);
    // Full email sent — operator outreach needs it (channel is private).
    expect(body.content).toMatch(/test@taproothq\.com/);
    // Regression guard against re-introducing the local-part mask.
    expect(body.content).not.toMatch(/\*\*\*@/);
  });

  it("does NOT ping Discord when workspace already exists (200)", async () => {
    mockGetMembership.mockResolvedValue({ workspaceId: EXISTING_WORKSPACE_ID });

    const res = makeRes();
    const req = {
      user: mockUser,
      body: {},
    };
    await callWorkspaceCreate(req, res);

    expect(res._status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT ping Discord when DISCORD_SIGNUPS_WEBHOOK_URL is unset", async () => {
    delete process.env.DISCORD_SIGNUPS_WEBHOOK_URL;
    mockGetMembership.mockResolvedValue(null);
    await mockSupabaseSuccess();

    const res = makeRes();
    const req = {
      user: mockUser,
      body: {},
    };
    await callWorkspaceCreate(req, res);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the full email for arbitrary addresses (tom@example.com appears unmasked)", async () => {
    mockUser.email = "tom@example.com";
    mockGetMembership.mockResolvedValue(null);
    await mockSupabaseSuccess();

    const res = makeRes();
    const req = {
      user: mockUser,
      body: {},
    };
    await callWorkspaceCreate(req, res);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toMatch(/tom@example\.com/);
    expect(body.content).not.toMatch(/\*\*\*@/);
  });

  it("falls back to 'unknown' when user.email is undefined", async () => {
    mockUser.email = undefined;
    mockGetMembership.mockResolvedValue(null);
    await mockSupabaseSuccess();

    const res = makeRes();
    const req = {
      user: mockUser,
      body: {},
    };
    await callWorkspaceCreate(req, res);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toMatch(/\| unknown \|/);
    expect(body.content).not.toMatch(/@/);
  });

  it("does NOT reuse DISCORD_ERROR_WEBHOOK_URL or DISCORD_FEEDBACK_WEBHOOK_URL", async () => {
    // Defense-in-depth: even if SIGNUPS is unset but ERROR/FEEDBACK are set,
    // we must NOT fall back to the wrong channel.
    delete process.env.DISCORD_SIGNUPS_WEBHOOK_URL;
    process.env.DISCORD_ERROR_WEBHOOK_URL = "https://discord.test/error";
    process.env.DISCORD_FEEDBACK_WEBHOOK_URL = "https://discord.test/feedback";
    mockGetMembership.mockResolvedValue(null);
    await mockSupabaseSuccess();

    const res = makeRes();
    const req = {
      user: mockUser,
      body: {},
    };
    await callWorkspaceCreate(req, res);

    expect(fetchSpy).not.toHaveBeenCalled();

    delete process.env.DISCORD_ERROR_WEBHOOK_URL;
    delete process.env.DISCORD_FEEDBACK_WEBHOOK_URL;
  });
});
