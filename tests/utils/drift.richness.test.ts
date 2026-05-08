import { describe, it, expect } from "vitest";
import {
  computeFlagsUpdate,
  parseRulesFromClaudeMd,
  type Rule,
} from "../../src/utils/drift.js";
import { composePersonaClaudeMd } from "../../src/tools/persona-claudemd.js";

const NO_ROOT_RULE: Rule = {
  kind: "no-root-files",
  allowlist: ["CLAUDE.md", "index.md"],
};

describe("drift richness — wrong_folder reason", () => {
  it("emits wrong_folder reason with context for root-level violation", () => {
    const result = computeFlagsUpdate("rogue.md", undefined, [NO_ROOT_RULE]);
    expect(result?.set?.outside_rules).toBe("true");
    expect(result?.set?.outside_rules_reason).toBe("wrong_folder");
    expect(result?.set?.outside_rules_context).toBe(
      "file at vault root; expected subfolder",
    );
  });

  it("context is capped at 200 chars if somehow long", () => {
    const result = computeFlagsUpdate("rogue.md", undefined, [NO_ROOT_RULE]);
    const ctx = result?.set?.outside_rules_context ?? "";
    expect(ctx.length).toBeLessThanOrEqual(200);
  });

  it("legacy outside_rules: 'true' still emitted alongside new fields", () => {
    const result = computeFlagsUpdate("rogue.md", undefined, [NO_ROOT_RULE]);
    expect(result?.set?.outside_rules).toBe("true");
    expect(result?.set?.outside_rules_reason).toBeDefined();
  });
});

describe("drift richness — structured_record reason", () => {
  it("emits structured_record reason for each hardcoded CRM folder", () => {
    for (const folder of [
      "leads",
      "contacts",
      "customers",
      "companies",
      "prospects",
      "accounts",
    ]) {
      const result = computeFlagsUpdate(`${folder}/jane.md`, undefined, [
        NO_ROOT_RULE,
      ]);
      expect(result?.set?.outside_rules_reason).toBe("structured_record");
      // Structured records are NOT violations
      expect(result?.set?.outside_rules).toBeUndefined();
      expect(result?.remove).toContain("outside_rules");
    }
  });

  it("emits structured_record for frontmatter-detected records (type: lead)", () => {
    const content = "---\ntype: lead\n---\n# Jane Smith";
    const result = computeFlagsUpdate("inbox/jane.md", content, [NO_ROOT_RULE]);
    expect(result?.set?.outside_rules_reason).toBe("structured_record");
    expect(result?.set?.outside_rules).toBeUndefined();
  });

  it("frontmatter-detected: type is case-insensitive", () => {
    const content = "---\ntype: Contact\n---";
    const result = computeFlagsUpdate("notes/person.md", content, [
      NO_ROOT_RULE,
    ]);
    expect(result?.set?.outside_rules_reason).toBe("structured_record");
  });

  it("no structured_record reason for non-CRM types in frontmatter", () => {
    const content = "---\ntype: article\n---";
    const result = computeFlagsUpdate("notes/foo.md", content, [NO_ROOT_RULE]);
    // notes/foo.md is nested, so it's compliant — no violation, no structured_record
    expect(result?.set?.outside_rules_reason).toBeUndefined();
    expect(result?.remove).toContain("outside_rules");
  });
});

describe("drift richness — compliance removes all reason fields", () => {
  it("remove list includes all three fields on compliance", () => {
    const result = computeFlagsUpdate("notes/foo.md", undefined, [
      NO_ROOT_RULE,
    ]);
    expect(result?.remove).toContain("outside_rules");
    expect(result?.remove).toContain("outside_rules_reason");
    expect(result?.remove).toContain("outside_rules_context");
  });
});

describe("drift richness — rules parsed from persona CLAUDE.md", () => {
  it("no-root-files rule extracted from persona-rendered CLAUDE.md emits wrong_folder on violation", () => {
    const claudeMd = composePersonaClaudeMd({ traits: ["founder"] });
    const rules = parseRulesFromClaudeMd(claudeMd);
    expect(rules.length).toBeGreaterThan(0);

    const result = computeFlagsUpdate("random.md", undefined, rules);
    expect(result?.set?.outside_rules).toBe("true");
    expect(result?.set?.outside_rules_reason).toBe("wrong_folder");
  });
});
