import { describe, it, expect } from "vitest";
import {
  ONBOARDING_STEPS,
  coerceLegacyStep,
} from "../../src/api/onboarding.js";

/**
 * Regression net for the 2026-05-07 first-wow walk incident: PRODUCT pod
 * was running pre-F6 code where `"rules-review"` had not yet been added
 * to `ONBOARDING_STEPS`, so `/api/onboarding/step` rejected the step the
 * SITE was advancing to with 400 invalid_step.
 *
 * The deploy-lag class is mitigated by T11-G-SMOKE Step 0 (active deploy
 * vs origin/main verification before any helper release walk). These
 * tests cover the COMPLEMENTARY code-side regression class — someone
 * removes / reorders / mistypes a step in the array and breaks the
 * forward-only monotonicity guard.
 *
 * If you change the SITE's onboarding sequence, update both
 * `ONBOARDING_STEPS` AND this file together.
 */
describe("ONBOARDING_STEPS structural invariants", () => {
  it("includes the SITE-required steps", () => {
    // Every step the SITE flow advances through must be present. Removing
    // any of these breaks the corresponding /onboarding/* page on the
    // first POST to /api/onboarding/step.
    for (const step of [
      "persona",
      "clients",
      "obsidian",
      "helper",
      "permissions",
      "connect",
      "first-wow",
      "rules-review",
      "done",
      "complete",
    ]) {
      expect(ONBOARDING_STEPS, `missing step: ${step}`).toContain(step);
    }
  });

  it("sequences first-wow immediately before rules-review", () => {
    // The 2026-05-07 bug surfaced specifically at this transition:
    // SITE advances first-wow → rules-review, server rejected rules-review
    // because it wasn't in the array. The forward-only monotonicity guard
    // in /onboarding/step depends on rules-review being at first-wow + 1.
    const firstWow = ONBOARDING_STEPS.indexOf("first-wow");
    const rulesReview = ONBOARDING_STEPS.indexOf("rules-review");
    expect(firstWow).toBeGreaterThanOrEqual(0);
    expect(rulesReview).toBe(firstWow + 1);
  });

  it("sequences rules-review immediately before done", () => {
    // Symmetric guard for the next transition. SITE done page calls
    // /onboarding/step with step="done"; if rules-review is reordered
    // past done, the forward-only guard rejects it as cannot_move_backward.
    const rulesReview = ONBOARDING_STEPS.indexOf("rules-review");
    const done = ONBOARDING_STEPS.indexOf("done");
    expect(rulesReview).toBeGreaterThanOrEqual(0);
    expect(done).toBe(rulesReview + 1);
  });

  it("places done immediately before complete", () => {
    // Final transition: /onboarding/done → /onboarding/complete on SITE.
    const done = ONBOARDING_STEPS.indexOf("done");
    const complete = ONBOARDING_STEPS.indexOf("complete");
    expect(done).toBeGreaterThanOrEqual(0);
    expect(complete).toBe(done + 1);
  });

  it("does not include the legacy 'vault' step (replaced by 'obsidian' on 2026-05-06)", () => {
    // The pivot replaced vault → obsidian. Re-introducing "vault" to
    // ONBOARDING_STEPS would let workspaces with onboarding_step="vault"
    // (legacy ones the coerceLegacyStep shim covers) skip the shim and
    // reach inconsistent state.
    expect(ONBOARDING_STEPS).not.toContain("vault");
  });
});

describe("coerceLegacyStep: round-trip with ONBOARDING_STEPS", () => {
  it("passes every current step through unchanged", () => {
    // Defends against a future ONBOARDING_STEPS edit accidentally
    // hitting the legacy-shim branch ("vault" → "obsidian"). Pairs with
    // the existing onboarding.test.ts which seeds the canonical set.
    for (const step of ONBOARDING_STEPS) {
      expect(coerceLegacyStep(step)).toBe(step);
    }
  });
});
