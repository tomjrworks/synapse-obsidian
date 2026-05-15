import { describe, it, expect } from "vitest";
import {
  isSubscriptionActive,
  getSubscriptionGate,
  getDaysRemaining,
  type WorkspaceSubscription,
} from "../../src/api/subscription.js";

// ---------------------------------------------------------------------------
// Unit tests for isSubscriptionActive + getDaysRemaining.
// No network calls — all inputs are constructed fixtures.
// ---------------------------------------------------------------------------

function makeSub(
  overrides: Partial<WorkspaceSubscription>,
): WorkspaceSubscription {
  return {
    workspace_id: "ws-test",
    stripe_customer_id: null,
    stripe_subscription_id: null,
    status: "trialing",
    trial_ends_at: null,
    current_period_end: null,
    canceled_at: null,
    grandfathered_at: null,
    trial_warning_sent_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

describe("isSubscriptionActive", () => {
  it("active → true", () => {
    expect(isSubscriptionActive(makeSub({ status: "active" }))).toBe(true);
  });

  it("grandfathered → true", () => {
    expect(isSubscriptionActive(makeSub({ status: "grandfathered" }))).toBe(
      true,
    );
  });

  it("trialing with future trial_ends_at → true", () => {
    expect(
      isSubscriptionActive(
        makeSub({ status: "trialing", trial_ends_at: daysFromNow(10) }),
      ),
    ).toBe(true);
  });

  it("trialing with past trial_ends_at but in grace window → true", () => {
    expect(
      isSubscriptionActive(
        makeSub({ status: "trialing", trial_ends_at: daysFromNow(-1) }),
      ),
    ).toBe(true);
  });

  it("trialing with trial_ends_at past grace window → false (expired)", () => {
    expect(
      isSubscriptionActive(
        makeSub({ status: "trialing", trial_ends_at: daysFromNow(-8) }),
      ),
    ).toBe(false);
  });

  it("trialing with null trial_ends_at → false", () => {
    expect(
      isSubscriptionActive(
        makeSub({ status: "trialing", trial_ends_at: null }),
      ),
    ).toBe(false);
  });

  it("canceled → false", () => {
    expect(isSubscriptionActive(makeSub({ status: "canceled" }))).toBe(false);
  });

  it("past_due → false", () => {
    expect(isSubscriptionActive(makeSub({ status: "past_due" }))).toBe(false);
  });
});

describe("isSubscriptionActive — grace window backward compat", () => {
  it("trialing, expired 3 days ago (in grace) → true", () => {
    expect(
      isSubscriptionActive(
        makeSub({ status: "trialing", trial_ends_at: daysFromNow(-3) }),
      ),
    ).toBe(true);
  });

  it("trialing, expired 8 days ago (past grace) → false", () => {
    expect(
      isSubscriptionActive(
        makeSub({ status: "trialing", trial_ends_at: daysFromNow(-8) }),
      ),
    ).toBe(false);
  });
});

describe("getSubscriptionGate", () => {
  it("active → allowed=true grace_period=false", () => {
    expect(getSubscriptionGate(makeSub({ status: "active" }))).toEqual({
      allowed: true,
      grace_period: false,
    });
  });

  it("grandfathered → allowed=true grace_period=false", () => {
    expect(getSubscriptionGate(makeSub({ status: "grandfathered" }))).toEqual({
      allowed: true,
      grace_period: false,
    });
  });

  it("trialing, future trial_ends_at → allowed=true grace_period=false", () => {
    expect(
      getSubscriptionGate(
        makeSub({ status: "trialing", trial_ends_at: daysFromNow(10) }),
      ),
    ).toEqual({ allowed: true, grace_period: false });
  });

  it("trialing, expired 3 days ago (in grace window) → allowed=true grace_period=true", () => {
    expect(
      getSubscriptionGate(
        makeSub({ status: "trialing", trial_ends_at: daysFromNow(-3) }),
      ),
    ).toEqual({ allowed: true, grace_period: true });
  });

  it("trialing, expired 6 days ago (within grace window) → allowed=true grace_period=true", () => {
    expect(
      getSubscriptionGate(
        makeSub({ status: "trialing", trial_ends_at: daysFromNow(-6) }),
      ),
    ).toEqual({ allowed: true, grace_period: true });
  });

  it("trialing, expired 8 days ago (past grace) → allowed=false grace_period=false", () => {
    expect(
      getSubscriptionGate(
        makeSub({ status: "trialing", trial_ends_at: daysFromNow(-8) }),
      ),
    ).toEqual({ allowed: false, grace_period: false });
  });

  it("canceled → allowed=false grace_period=false", () => {
    expect(getSubscriptionGate(makeSub({ status: "canceled" }))).toEqual({
      allowed: false,
      grace_period: false,
    });
  });

  it("trialing, null trial_ends_at → allowed=false grace_period=false", () => {
    expect(
      getSubscriptionGate(makeSub({ status: "trialing", trial_ends_at: null })),
    ).toEqual({ allowed: false, grace_period: false });
  });
});

describe("getDaysRemaining", () => {
  it("active sub → null", () => {
    expect(getDaysRemaining(makeSub({ status: "active" }))).toBeNull();
  });

  it("grandfathered → null", () => {
    expect(getDaysRemaining(makeSub({ status: "grandfathered" }))).toBeNull();
  });

  it("trialing with null trial_ends_at → null", () => {
    expect(
      getDaysRemaining(makeSub({ status: "trialing", trial_ends_at: null })),
    ).toBeNull();
  });

  it("trialing with 10 days left → positive number ~10", () => {
    const days = getDaysRemaining(
      makeSub({ status: "trialing", trial_ends_at: daysFromNow(10) }),
    );
    expect(days).not.toBeNull();
    expect(days!).toBeGreaterThanOrEqual(9);
    expect(days!).toBeLessThanOrEqual(10);
  });

  it("trialing with expired trial → negative number", () => {
    const days = getDaysRemaining(
      makeSub({ status: "trialing", trial_ends_at: daysFromNow(-3) }),
    );
    expect(days).not.toBeNull();
    expect(days!).toBeLessThan(0);
  });
});
