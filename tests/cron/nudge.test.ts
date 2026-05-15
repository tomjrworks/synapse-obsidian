import { describe, it, expect, vi, beforeEach } from "vitest";
import { runDayThirtyOneNudge } from "../../src/cron/nudge.js";

// ---------------------------------------------------------------------------
// Unit tests for the day-31 nudge cron.
// No real Supabase, email, or workspace calls — all mocked.
// ---------------------------------------------------------------------------

const mockSendTrialEndedEmail = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/utils/email.js", () => ({
  sendTrialEndedEmail: (...args: unknown[]) => mockSendTrialEndedEmail(...args),
}));

const mockGetMembershipForWorkspace = vi.fn();
vi.mock("../../src/api/workspace.js", () => ({
  getMembershipForWorkspace: (...args: unknown[]) =>
    mockGetMembershipForWorkspace(...args),
}));

// Chainable Supabase query builder — last method resolves the promise.
function makeQueryChain(result: { data: unknown; error: unknown }) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    lt: vi.fn().mockResolvedValue(result),
  };
  return chain;
}

// Auth admin mock for getUserById
function makeAuthMock(email: string | null) {
  return {
    auth: {
      admin: {
        getUserById: vi.fn().mockResolvedValue({
          data: { user: email ? { email } : null },
        }),
      },
    },
  };
}

let mockFrom: ReturnType<typeof vi.fn>;
let mockAuthAdmin: ReturnType<typeof makeAuthMock>;

vi.mock("../../src/api/supabase.js", () => ({
  supabaseService: () => ({
    get from() {
      return mockFrom;
    },
    get auth() {
      return mockAuthAdmin.auth;
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthAdmin = makeAuthMock("user@example.com");
});

describe("runDayThirtyOneNudge", () => {
  it("sends email to workspaces whose trial ended yesterday", async () => {
    const queryChain = makeQueryChain({
      data: [{ workspace_id: "ws-abc" }],
      error: null,
    });
    mockFrom = vi.fn().mockReturnValue(queryChain);
    mockGetMembershipForWorkspace.mockResolvedValue({
      workspaceId: "ws-abc",
      userId: "user-1",
      name: "test",
      settings: {},
    });

    const result = await runDayThirtyOneNudge();

    expect(result).toEqual({ sent: 1, errors: 0 });
    expect(mockSendTrialEndedEmail).toHaveBeenCalledOnce();
    expect(mockSendTrialEndedEmail).toHaveBeenCalledWith("user@example.com");
  });

  it("handles missing email gracefully — no send, no error count", async () => {
    const queryChain = makeQueryChain({
      data: [{ workspace_id: "ws-noemail" }],
      error: null,
    });
    mockFrom = vi.fn().mockReturnValue(queryChain);
    mockGetMembershipForWorkspace.mockResolvedValue({
      workspaceId: "ws-noemail",
      userId: "user-2",
      name: "test",
      settings: {},
    });
    mockAuthAdmin = makeAuthMock(null);

    const result = await runDayThirtyOneNudge();

    expect(result).toEqual({ sent: 0, errors: 0 });
    expect(mockSendTrialEndedEmail).not.toHaveBeenCalled();
  });

  it("handles missing membership gracefully — no send, no error count", async () => {
    const queryChain = makeQueryChain({
      data: [{ workspace_id: "ws-nomem" }],
      error: null,
    });
    mockFrom = vi.fn().mockReturnValue(queryChain);
    mockGetMembershipForWorkspace.mockResolvedValue(null);

    const result = await runDayThirtyOneNudge();

    expect(result).toEqual({ sent: 0, errors: 0 });
    expect(mockSendTrialEndedEmail).not.toHaveBeenCalled();
  });

  it("counts errors when sendTrialEndedEmail throws", async () => {
    const queryChain = makeQueryChain({
      data: [{ workspace_id: "ws-fail" }],
      error: null,
    });
    mockFrom = vi.fn().mockReturnValue(queryChain);
    mockGetMembershipForWorkspace.mockResolvedValue({
      workspaceId: "ws-fail",
      userId: "user-3",
      name: "test",
      settings: {},
    });
    mockSendTrialEndedEmail.mockRejectedValueOnce(new Error("Resend down"));

    const result = await runDayThirtyOneNudge();

    expect(result).toEqual({ sent: 0, errors: 1 });
  });

  it("returns early with errors=1 when Supabase query fails", async () => {
    const queryChain = makeQueryChain({
      data: null,
      error: new Error("DB error"),
    });
    mockFrom = vi.fn().mockReturnValue(queryChain);

    const result = await runDayThirtyOneNudge();

    expect(result).toEqual({ sent: 0, errors: 1 });
    expect(mockSendTrialEndedEmail).not.toHaveBeenCalled();
  });

  it("queries with yesterday UTC date range to prevent double-fire across days", async () => {
    const queryChain = makeQueryChain({ data: [], error: null });
    mockFrom = vi.fn().mockReturnValue(queryChain);

    await runDayThirtyOneNudge();

    // Confirm .gte and .lt were called with ISO strings straddling midnight UTC
    expect(queryChain.gte).toHaveBeenCalledOnce();
    expect(queryChain.lt).toHaveBeenCalledOnce();

    const gteArg = queryChain.gte.mock.calls[0][1] as string;
    const ltArg = queryChain.lt.mock.calls[0][1] as string;

    const gteDate = new Date(gteArg);
    const ltDate = new Date(ltArg);

    // lt must be exactly today at 00:00 UTC
    const todayMidnight = new Date();
    todayMidnight.setUTCHours(0, 0, 0, 0);
    expect(ltDate.getTime()).toBe(todayMidnight.getTime());

    // gte must be exactly yesterday at 00:00 UTC (24h before lt)
    expect(ltDate.getTime() - gteDate.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("sends to multiple workspaces in one run", async () => {
    const queryChain = makeQueryChain({
      data: [{ workspace_id: "ws-1" }, { workspace_id: "ws-2" }],
      error: null,
    });
    mockFrom = vi.fn().mockReturnValue(queryChain);
    mockGetMembershipForWorkspace.mockResolvedValue({
      workspaceId: "ws-x",
      userId: "user-x",
      name: "test",
      settings: {},
    });

    const result = await runDayThirtyOneNudge();

    expect(result).toEqual({ sent: 2, errors: 0 });
    expect(mockSendTrialEndedEmail).toHaveBeenCalledTimes(2);
  });
});
