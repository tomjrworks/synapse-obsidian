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
// event_id has been recorded; upsert records it. `dedupeUpsertResult`
// controls what the upsert returns — defaults to { error: null }, but
// individual tests can mutate it before posting to simulate a PostgREST
// failure on the idempotency-marker write (S98).
let dedupeUpsertResult: { error: { message: string } | null } = { error: null };
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
      if (dedupeUpsertResult.error === null) {
        seenEvents.add(row.event_id);
      }
      return dedupeUpsertResult;
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
    dedupeUpsertResult = { error: null };
    mockUpsert.mockResolvedValue({ error: null });
    mockUpdate.mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });
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

  // ── S98: supabase-js returns { error } (does NOT throw) → must surface ─
  //
  // PostgREST errors (RLS denial, schema mismatch, transient connection) come
  // back as { error: {...} } on the resolved promise, not as a rejection.
  // Before the S98 fix, the handler ignored `error` and proceeded to record
  // the event as processed — Stripe stopped retrying and billing state
  // permanently diverged. These tests assert the handler now returns 500 and
  // does NOT mark the event processed.

  it("S98: checkout.session.completed upsert {error} → 500, not deduped", async () => {
    mockUpsert.mockResolvedValueOnce({
      error: { message: "rls denied on workspace_subscriptions" },
    });
    const event = {
      id: "evt_s98_checkout",
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
    expect(res.status).toBe(500);
    expect(seenEvents.has("evt_s98_checkout")).toBe(false);

    await new Promise((r) => server.close(r));
  });

  it("S98: customer.subscription.updated update {error} → 500, not deduped", async () => {
    mockUpdate.mockReturnValueOnce({
      eq: vi.fn().mockResolvedValue({
        error: { message: "rls denied on workspace_subscriptions" },
      }),
    });
    const event = {
      id: "evt_s98_updated",
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
    expect(seenEvents.has("evt_s98_updated")).toBe(false);

    await new Promise((r) => server.close(r));
  });

  it("S98: customer.subscription.deleted update {error} → 500, not deduped", async () => {
    mockUpdate.mockReturnValueOnce({
      eq: vi.fn().mockResolvedValue({
        error: { message: "rls denied on workspace_subscriptions" },
      }),
    });
    const event = {
      id: "evt_s98_deleted",
      type: "customer.subscription.deleted",
      data: {
        object: { customer: "cus_test", items: { data: [] } },
      },
    };

    const res = await post(url, event);
    expect(res.status).toBe(500);
    expect(seenEvents.has("evt_s98_deleted")).toBe(false);

    await new Promise((r) => server.close(r));
  });

  it("S98: invoice.payment_failed update {error} → 500, not deduped", async () => {
    mockUpdate.mockReturnValueOnce({
      eq: vi.fn().mockResolvedValue({
        error: { message: "rls denied on workspace_subscriptions" },
      }),
    });
    const event = {
      id: "evt_s98_payfail",
      type: "invoice.payment_failed",
      data: { object: { customer: "cus_test", parent: null } },
    };

    const res = await post(url, event);
    expect(res.status).toBe(500);
    expect(seenEvents.has("evt_s98_payfail")).toBe(false);

    await new Promise((r) => server.close(r));
  });

  it("S98: invoice.payment_succeeded update {error} → 500, not deduped", async () => {
    mockUpdate.mockReturnValueOnce({
      eq: vi.fn().mockResolvedValue({
        error: { message: "rls denied on workspace_subscriptions" },
      }),
    });
    const event = {
      id: "evt_s98_paysucc",
      type: "invoice.payment_succeeded",
      data: { object: { customer: "cus_test", parent: null } },
    };

    const res = await post(url, event);
    expect(res.status).toBe(500);
    expect(seenEvents.has("evt_s98_paysucc")).toBe(false);

    await new Promise((r) => server.close(r));
  });

  it("S98: processed_webhook_events upsert {error} → 500, retry-safe", async () => {
    // Branch write succeeds; dedupe-marker write fails. Handler must return
    // 500 so Stripe retries — reprocess is safe because all branch writes
    // are upserts/updates keyed on workspace_id.
    dedupeUpsertResult = {
      error: { message: "rls denied on processed_webhook_events" },
    };
    const event = {
      id: "evt_s98_dedupe",
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
    // Dedupe write itself failed — the marker is NOT recorded, so a Stripe
    // retry will reprocess the event (which is idempotent by design).
    expect(seenEvents.has("evt_s98_dedupe")).toBe(false);
    // Branch write DID succeed before the dedupe failure — assert that to
    // catch a regression where the structural reordering breaks the happy
    // path.
    expect(mockUpdate).toHaveBeenCalledOnce();

    await new Promise((r) => server.close(r));
  });
});
