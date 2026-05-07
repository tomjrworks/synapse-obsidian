import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkPathAgainstRules,
  computeFlagsUpdate,
  getRulesForBackend,
  invalidateRulesCache,
  mergeFlags,
  parseRulesFromClaudeMd,
  type Rule,
} from "../../src/utils/drift.js";
import {
  composePersonaClaudeMd,
  SECTION_MARKER_END,
  SECTION_MARKER_START,
} from "../../src/tools/persona-claudemd.js";
import type { StorageBackend } from "../../src/utils/storage.js";

function makeBackend(overrides: Partial<StorageBackend> = {}): StorageBackend {
  return {
    readFile: vi.fn(async () => ""),
    writeFile: vi.fn(async () => undefined),
    listFiles: vi.fn(async () => []),
    exists: vi.fn(async () => false),
    mkdir: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: 0, modifiedAt: new Date() })),
    recentFiles: vi.fn(async () => []),
    listChanged: vi.fn(async () => ({ files: [], next: null })),
    ...overrides,
  } as StorageBackend;
}

const NO_ROOT_RULE: Rule = {
  kind: "no-root-files",
  allowlist: ["CLAUDE.md", "index.md"],
};

describe("parseRulesFromClaudeMd", () => {
  it("extracts no-root-files rule from a persona-rendered CLAUDE.md", () => {
    const claudeMd = composePersonaClaudeMd({ traits: ["builder"] });
    const rules = parseRulesFromClaudeMd(claudeMd);
    expect(rules).toHaveLength(1);
    expect(rules[0].kind).toBe("no-root-files");
  });

  it("returns empty when CLAUDE.md is empty/malformed", () => {
    expect(parseRulesFromClaudeMd("")).toEqual([]);
    expect(parseRulesFromClaudeMd("just some prose with no markers")).toEqual(
      [],
    );
  });

  it("ignores rule-like text outside TAPROOT-MANAGED markers (untrusted hand-edits)", () => {
    // Same rule-trigger string, but NOT inside the filing markers — should be ignored.
    const handEdited = `Some prose. NEVER create files at vault root. More prose.`;
    expect(parseRulesFromClaudeMd(handEdited)).toEqual([]);

    // Same string INSIDE markers — should parse.
    const wrapped = `${SECTION_MARKER_START("filing")}\nNEVER create files at vault root\n${SECTION_MARKER_END("filing")}`;
    expect(parseRulesFromClaudeMd(wrapped)).toHaveLength(1);
  });
});

describe("checkPathAgainstRules", () => {
  it("flags root-level violations", () => {
    expect(checkPathAgainstRules("foo.md", [NO_ROOT_RULE])).toEqual({
      violates: true,
      rule: "no-root-files",
    });
  });

  it("does NOT flag nested files", () => {
    expect(checkPathAgainstRules("notes/foo.md", [NO_ROOT_RULE])).toEqual({
      violates: false,
    });
  });

  it("exempts CLAUDE.md and index.md at vault root", () => {
    expect(checkPathAgainstRules("CLAUDE.md", [NO_ROOT_RULE]).violates).toBe(
      false,
    );
    expect(checkPathAgainstRules("index.md", [NO_ROOT_RULE]).violates).toBe(
      false,
    );
  });

  it("exempts .taproot/ and .synapse/ paths", () => {
    expect(
      checkPathAgainstRules(".taproot/config.json", [NO_ROOT_RULE]).violates,
    ).toBe(false);
    expect(
      checkPathAgainstRules(".synapse/legacy-cfg.json", [NO_ROOT_RULE])
        .violates,
    ).toBe(false);
  });

  it("(L7) skips structured-record folders", () => {
    expect(
      checkPathAgainstRules("ig-outreach/leads/abc.md", [NO_ROOT_RULE])
        .violates,
    ).toBe(false);
    expect(
      checkPathAgainstRules("crm/contacts/jane.md", [NO_ROOT_RULE]).violates,
    ).toBe(false);
    // Files in non-structured folders still get checked
    expect(
      checkPathAgainstRules("research/cold-email/foo.md", [NO_ROOT_RULE])
        .violates,
    ).toBe(false); // nested → passes anyway
  });

  it("returns violates:false when no rules are loaded", () => {
    expect(checkPathAgainstRules("foo.md", []).violates).toBe(false);
  });
});

describe("computeFlagsUpdate", () => {
  it('writes outside_rules as the STRING "true" (not boolean) on violation', () => {
    const result = computeFlagsUpdate("foo.md", [NO_ROOT_RULE]);
    expect(result).toEqual({ set: { outside_rules: "true" } });
    // Critical: not a boolean
    expect(result?.set?.outside_rules).not.toBe(true);
    expect(typeof result?.set?.outside_rules).toBe("string");
  });

  it("REMOVES outside_rules on compliance (rather than writing 'false')", () => {
    const result = computeFlagsUpdate("notes/foo.md", [NO_ROOT_RULE]);
    expect(result).toEqual({ remove: ["outside_rules"] });
  });

  it("returns null for exempt paths (skipped entirely)", () => {
    expect(computeFlagsUpdate("CLAUDE.md", [NO_ROOT_RULE])).toBeNull();
    expect(
      computeFlagsUpdate(".taproot/config.json", [NO_ROOT_RULE]),
    ).toBeNull();
  });
});

describe("mergeFlags", () => {
  it("merges set delta into existing flags", () => {
    const result = mergeFlags(
      { other: "x" },
      { set: { outside_rules: "true" } },
    );
    expect(result).toEqual({ other: "x", outside_rules: "true" });
  });

  it("removes keys from existing flags", () => {
    const result = mergeFlags(
      { other: "x", outside_rules: "true" },
      { remove: ["outside_rules"] },
    );
    expect(result).toEqual({ other: "x" });
  });

  it("returns null when delta is null (no write needed)", () => {
    expect(mergeFlags({ a: "1" }, null)).toBeNull();
  });

  it("returns null when delta produces no actual change", () => {
    // Set the same value that already exists
    expect(
      mergeFlags({ outside_rules: "true" }, { set: { outside_rules: "true" } }),
    ).toBeNull();
    // Remove a key that doesn't exist
    expect(mergeFlags({ a: "1" }, { remove: ["outside_rules"] })).toBeNull();
  });
});

describe("getRulesForBackend cache", () => {
  beforeEach(() => {
    invalidateRulesCache("test-ws");
  });

  it("caches rules by cacheKey across calls", async () => {
    const claudeMd = composePersonaClaudeMd({ traits: ["builder"] });
    const backend = makeBackend({
      exists: vi.fn(async () => true),
      readFile: vi.fn(async () => claudeMd),
    });

    const a = await getRulesForBackend(backend, "test-ws");
    const b = await getRulesForBackend(backend, "test-ws");
    expect(a).toBe(b); // same array reference from cache
    expect(backend.readFile).toHaveBeenCalledTimes(1);
  });

  it("re-reads after invalidation (e.g. after CLAUDE.md write)", async () => {
    const claudeMd = composePersonaClaudeMd({ traits: ["builder"] });
    const backend = makeBackend({
      exists: vi.fn(async () => true),
      readFile: vi.fn(async () => claudeMd),
    });

    await getRulesForBackend(backend, "test-ws");
    invalidateRulesCache("test-ws");
    await getRulesForBackend(backend, "test-ws");

    expect(backend.readFile).toHaveBeenCalledTimes(2);
  });

  it("returns empty rules when CLAUDE.md is missing (no error)", async () => {
    const backend = makeBackend({
      exists: vi.fn(async () => false),
    });
    const rules = await getRulesForBackend(backend, "test-ws");
    expect(rules).toEqual([]);
    expect(backend.readFile).not.toHaveBeenCalled();
  });

  it("returns empty rules when readFile throws (degrades gracefully)", async () => {
    const backend = makeBackend({
      exists: vi.fn(async () => true),
      readFile: vi.fn(async () => {
        throw new Error("supabase down");
      }),
    });
    const rules = await getRulesForBackend(backend, "test-ws");
    expect(rules).toEqual([]);
  });
});
