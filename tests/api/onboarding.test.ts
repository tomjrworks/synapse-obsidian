import { describe, it, expect } from "vitest";
import { coerceLegacyStep } from "../../src/api/onboarding.js";

describe("coerceLegacyStep", () => {
  it('maps legacy "vault" step to "obsidian"', () => {
    expect(coerceLegacyStep("vault")).toBe("obsidian");
  });

  it('maps legacy "persona" step to "clients"', () => {
    expect(coerceLegacyStep("persona")).toBe("clients");
  });

  it("passes through current onboarding steps unchanged", () => {
    for (const step of [
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
      expect(coerceLegacyStep(step)).toBe(step);
    }
  });
});
