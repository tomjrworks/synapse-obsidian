import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { stripeWebhookHandler } from "../../src/api/stripe-webhook.js";

// ---------------------------------------------------------------------------
// Unit tests for the Stripe webhook handler.
//
// Strategy: mount the handler on a minimal Express app with express.raw(),
// bypass real Stripe signature verification by mocking the stripe module,
// and assert the correct DB upsert/update calls are made per event type.
//
// No real Supabase — supabase.js is mocked via vi.mock. The mock is
// table-aware: processed_webhook_events (C3 dedupe) is backed by an in-memory
// Set; everything else routes to the workspace_subscriptions spies.
// ---------------------------------------------------------------------------

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockUpsert = vi.fn().mockResolvedValue({ error: null });
const mockUpdate = vi.fn().mockReturnValue({
  eq: vi.fn().mockResolvedValue({ error: null }),
});
const mockSelect = vi.fn().mockReturnValue({
  eq: vi.fn().mockReturnValue({
    maybeSingle: vi.fn().mockResolvedValue({
      data: { workspace_id: "ws-fixture" },
      error: null,
    }),
  }),
});

// C3 dedupe table — in-memory fake. select/eq/maybeSingle reports whether an
// event_id has been recorded; upsert records it.
const seenEvents = new Set<string>();
function processedEventsTable() {
  return {
    select: () => ({
      eq: (_col: string, val: string) => ({
        maybeSingle: async () => ({
          data: seenEvents.has(val) ? { event_id: val } : null,
          error: null,
        }),
      }),
    }),
    upsert: async (row: { event_id: string }) => {
      seenEvents.add(row.event_id);
      return { error: null };
    },
  };
}

vi.mock("../../src/api/supabase.js", () => ({
  supabaseService: () => ({
    from: (table: string) =>
      table === "processed_webhook_events"
        ? processedEventsTable()
        : { upsert: mockUpsert, update: mockUpdate, select: mockSelect },
  }),
}));

// Fake Stripe: constructEvent returns the event we pass as rawBody JSON,
// and subscriptions.retrieve returns a minimal sub object.
vi.mock("stripe", () => {
  const fakeRetrieve = vi.fn().mockResolvedValue({
    status: "active",
    items: { data: [{ current_period_end: 1800000000 }] },
  });

  const StripeClass = vi.fn().mockImplementation(() => ({
    webhooks: {
      constructEvent: (_raw: Buffer, _sig: string, _secret: string) => {
        return JSON.parse(_raw.toString());
      },
    },
    subscriptions: { retrieve: fakeRetrieve },
  }));

  return { default: StripeClass };
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const app = express();
    app.post(
      "/api/stripe/webhook",
      express.raw({ type: "application/json" }),
      stripeWebhookHandler,
    );
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://localhost:${addr.port}` });
    });
  });
}

function post(url: string, body: object) {
  return fetch(`${url}/api/stripe/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": "fake-sig",
    },
    body: JSON.stringify(body),
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("stripeWebhookHandler", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_fake");
    mockUpsert.mockClear();
    mockUpdate.mockClear();
    seenEvents.clear();
    ({ server, url } = await makeServer());
  });

  it("returns 200 for checkout.session.completed and calls upsert", async () => {
    const event = {
      id: "evt_checkout_1",
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: { workspace_id: "ws-fixture" },
          customer: "cus_test",
          subscription: "sub_test",
        },
      },
    };

    const res = await post(url, event);
    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledOnce();
    const call = mockUpsert.mock.calls[0][0];
    expect(call.workspace_id).toBe("ws-fixture");
    expect(call.stripe_customer_id).toBe("cus_test");
    expect(call.stripe_subscription_id).toBe("sub_test");
    expect(call.status).toBe("active");

    await new Promise((r) => server.close(r));
  });

  it("returns 200 for customer.subscription.updated and calls update", async () => {
    const event = {
      id: "evt_updated_1",
      type: "customer.subscription.updated",
      data: {
        object: {
          customer: "cus_test",
          status: "active",
          items: { data: [{ current_period_end: 1800000000 }] },
        },
      },
    };

    const res = await post(url, event);
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledOnce();
    const call = mockUpdate.mock.calls[0][0];
    expect(call.status).toBe("active");

    await new Promise((r) => server.close(r));
  });

  it("returns 200 for customer.subscription.deleted and sets canceled", async () => {
    const event = {
      id: "evt_deleted_1",
      type: "customer.subscription.deleted",
      data: {
        object: {
          customer: "cus_test",
          items: { data: [] },
        },
      },
    };

    const res = await post(url, event);
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledOnce();
    const call = mockUpdate.mock.calls[0][0];
    expect(call.status).toBe("canceled");
    expect(call.canceled_at).toBeDefined();

    await new Promise((r) => server.close(r));
  });

  it("returns 200 for invoice.payment_failed and sets past_due", async () => {
    const event = {
      id: "evt_failed_1",
      type: "invoice.payment_failed",
      data: {
        object: { customer: "cus_test", parent: null },
      },
    };

    const res = await post(url, event);
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledOnce();
    const call = mockUpdate.mock.calls[0][0];
    expect(call.status).toBe("past_due");

    await new Promise((r) => server.close(r));
  });

  it("returns 200 for invoice.payment_succeeded and sets active", async () => {
    const event = {
      id: "evt_succeeded_1",
      type: "invoice.payment_succeeded",
      data: {
        object: { customer: "cus_test", parent: null },
      },
    };

    const res = await post(url, event);
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledOnce();
    const call = mockUpdate.mock.calls[0][0];
    expect(call.status).toBe("active");

    await new Promise((r) => server.close(r));
  });

  it("returns 200 for unknown event type (idempotency — no crash)", async () => {
    const event = {
      id: "evt_unknown_1",
      type: "some.unknown.event",
      data: { object: {} },
    };
    const res = await post(url, event);
    expect(res.status).toBe(200);
    await new Promise((r) => server.close(r));
  });

  it("returns 400 when stripe-signature header is missing", async () => {
    const res = await fetch(`${url}/api/stripe/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    await new Promise((r) => server.close(r));
  });

  // ── C3: event-ID dedupe ────────────────────────────────────────────────

  it("dedupes a redelivered event — second delivery is a no-op (C3)", async () => {
    const event = {
      id: "evt_redelivered",
      type: "customer.subscription.updated",
      data: {
        object: {
          customer: "cus_test",
          status: "active",
          items: { data: [{ current_period_end: 1800000000 }] },
        },
      },
    };

    const first = await post(url, event);
    expect(first.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledOnce();

    const second = await post(url, event);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ deduped: true });
    // Handler did NOT run again — update call count unchanged.
    expect(mockUpdate).toHaveBeenCalledOnce();

    await new Promise((r) => server.close(r));
  });

  // ── C4: transient handler error → non-2xx so Stripe retries ────────────

  it("returns 500 (not 200) when a handler throws (C4)", async () => {
    mockUpdate.mockReturnValueOnce({
      eq: vi.fn().mockRejectedValue(new Error("transient db error")),
    });

    const event = {
      id: "evt_transient_fail",
      type: "customer.subscription.updated",
      data: {
        object: {
          customer: "cus_test",
          status: "active",
          items: { data: [{ current_period_end: 1800000000 }] },
        },
      },
    };

    const res = await post(url, event);
    expect(res.status).toBe(500);
    // Event was NOT recorded — a Stripe retry must be able to reprocess it.
    expect(seenEvents.has("evt_transient_fail")).toBe(false);

    await new Promise((r) => server.close(r));
  });
});
