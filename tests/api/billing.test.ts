import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import express from "express";
import type { Server } from "node:http";
import type {
  WorkspaceSubscription,
  SubscriptionStatus,
} from "../../src/api/subscription.js";

// ---------------------------------------------------------------------------
// S10 regression: duplicate-checkout guard must block re-checkout when the
// workspace already holds a subscription in an "in-progress" status —
// trialing | active | past_due | paused — and ALLOW re-checkout for canceled
// or grandfathered (where the user genuinely wants to start a new sub).
//
// Strategy: mount the billing router on a minimal Express app, stub
// requireSupabaseAuth + requireWorkspace to seed a workspaceId, mock
// getSubscription to return a per-test fixture, and mock the Stripe SDK to
// capture customer.create + checkout.sessions.create calls. The assertion
// hinges on whether the handler short-circuits at the guard (409) or
// reaches the Stripe call (200).
// ---------------------------------------------------------------------------

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("../../src/api/middleware.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/api/middleware.js")>();
  const pass: express.RequestHandler = (req, _res, next) => {
    (req as Record<string, unknown>).membership = {
      workspaceId: "ws-billing-test",
    };
    next();
  };
  return { ...actual, requireSupabaseAuth: pass, requireWorkspace: pass };
});

// Per-test fixture: what getSubscription returns. null means "no sub row".
let subscriptionFixture: WorkspaceSubscription | null = null;

vi.mock("../../src/api/subscription.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/api/subscription.js")>();
  return {
    ...actual,
    getSubscription: vi.fn(async () => subscriptionFixture),
  };
});

// supabase.js — only used for the customer-create upsert side effect.
const mockSbUpsert = vi.fn().mockReturnValue({
  eq: vi.fn().mockResolvedValue({ error: null }),
});
vi.mock("../../src/api/supabase.js", () => ({
  supabaseService: () => ({
    from: () => ({ upsert: mockSbUpsert }),
  }),
}));

// Stripe mock — capture customer.create + checkout.sessions.create.
const mockCustomersCreate = vi.fn().mockResolvedValue({ id: "cus_new" });
const mockCheckoutCreate = vi
  .fn()
  .mockResolvedValue({ url: "https://checkout.stripe.com/fake-session" });
vi.mock("stripe", () => {
  const StripeClass = vi.fn().mockImplementation(() => ({
    customers: { create: mockCustomersCreate },
    checkout: { sessions: { create: mockCheckoutCreate } },
  }));
  return { default: StripeClass };
});

const { billingRouter } = await import("../../src/api/billing.js");

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeApp(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use("/api", billingRouter());
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function makeSub(
  status: SubscriptionStatus,
  opts: { withSubId?: boolean; withCustomerId?: boolean } = {},
): WorkspaceSubscription {
  const { withSubId = true, withCustomerId = true } = opts;
  return {
    workspace_id: "ws-billing-test",
    stripe_customer_id: withCustomerId ? "cus_existing" : null,
    stripe_subscription_id: withSubId ? "sub_existing" : null,
    status,
    trial_ends_at: null,
    current_period_end: null,
    canceled_at: null,
    grandfathered_at: null,
    trial_warning_sent_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function postCheckout(baseUrl: string) {
  return fetch(`${baseUrl}/api/billing/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ interval: "month" }),
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("POST /api/billing/checkout — S10 duplicate-checkout guard", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    vi.stubEnv("STRIPE_MONTHLY_PRICE_ID", "price_monthly_fake");
    vi.stubEnv("STRIPE_ANNUAL_PRICE_ID", "price_annual_fake");
    ({ server, baseUrl } = await makeApp());
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    subscriptionFixture = null;
    mockCustomersCreate.mockClear();
    mockCheckoutCreate.mockClear();
    mockSbUpsert.mockClear();
  });

  // ── allowed paths (should reach Stripe) ────────────────────────────────

  it("no sub row → 200 (first checkout)", async () => {
    subscriptionFixture = null;
    const res = await postCheckout(baseUrl);
    expect(res.status).toBe(200);
    expect(mockCheckoutCreate).toHaveBeenCalledOnce();
    expect(mockCustomersCreate).toHaveBeenCalledOnce(); // no customer yet
  });

  it("sub row with no stripe_subscription_id → 200 (customer created but never checked out)", async () => {
    subscriptionFixture = makeSub("trialing", {
      withSubId: false,
      withCustomerId: true,
    });
    const res = await postCheckout(baseUrl);
    expect(res.status).toBe(200);
    expect(mockCheckoutCreate).toHaveBeenCalledOnce();
    // Existing customer — no new customer.create
    expect(mockCustomersCreate).not.toHaveBeenCalled();
  });

  it("status=canceled with stripe_subscription_id → 200 (user can start a new sub)", async () => {
    subscriptionFixture = makeSub("canceled");
    const res = await postCheckout(baseUrl);
    expect(res.status).toBe(200);
    expect(mockCheckoutCreate).toHaveBeenCalledOnce();
  });

  it("status=grandfathered with stripe_subscription_id → 200 (grandfathered users can opt-in to paid)", async () => {
    subscriptionFixture = makeSub("grandfathered");
    const res = await postCheckout(baseUrl);
    expect(res.status).toBe(200);
    expect(mockCheckoutCreate).toHaveBeenCalledOnce();
  });

  // ── blocked paths (409 — no Stripe call) ───────────────────────────────

  it("S10: status=trialing with stripe_subscription_id → 409 (NEW — was unguarded)", async () => {
    subscriptionFixture = makeSub("trialing");
    const res = await postCheckout(baseUrl);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("already_subscribed");
    expect(mockCheckoutCreate).not.toHaveBeenCalled();
  });

  it("status=active with stripe_subscription_id → 409 (already covered by d8a4d25)", async () => {
    subscriptionFixture = makeSub("active");
    const res = await postCheckout(baseUrl);
    expect(res.status).toBe(409);
    expect(mockCheckoutCreate).not.toHaveBeenCalled();
  });

  it("status=past_due with stripe_subscription_id → 409 (already covered by d8a4d25)", async () => {
    subscriptionFixture = makeSub("past_due");
    const res = await postCheckout(baseUrl);
    expect(res.status).toBe(409);
    expect(mockCheckoutCreate).not.toHaveBeenCalled();
  });

  it("S10: status=paused with stripe_subscription_id → 409 (NEW — was unguarded)", async () => {
    subscriptionFixture = makeSub("paused");
    const res = await postCheckout(baseUrl);
    expect(res.status).toBe(409);
    expect(mockCheckoutCreate).not.toHaveBeenCalled();
  });
});
