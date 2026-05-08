import { describe, it, expect } from "vitest";
import {
  extractCardinality,
  renderCardinalityLine,
  MANAGED_INDEX_MARKER,
} from "../../src/utils/frontmatter.js";

describe("extractCardinality", () => {
  it("returns empty cardinality for empty content", () => {
    const result = extractCardinality("");
    expect(result).toEqual({ custom: {} });
  });

  it("returns empty cardinality for content with no frontmatter", () => {
    const result = extractCardinality("# My Note\n\nSome content here.");
    expect(result).toEqual({ custom: {} });
  });

  it("extracts all 5 first-class fields", () => {
    const content = [
      "---",
      "tags: [ai, productivity]",
      "status: active",
      "type: pickup",
      "created: 2026-05-08",
      "summary: A summary line",
      "---",
      "# Body",
    ].join("\n");
    const result = extractCardinality(content);
    expect(result.tags).toEqual(["ai", "productivity"]);
    expect(result.status).toBe("active");
    expect(result.type).toBe("pickup");
    expect(result.created).toBe("2026-05-08");
    expect(result.summary).toBe("A summary line");
    expect(result.custom).toEqual({});
  });

  it("normalizes tags: lowercased and deduped", () => {
    const content = "---\ntags: [AI, Productivity, ai]\n---";
    const result = extractCardinality(content);
    expect(result.tags).toEqual(["ai", "productivity"]);
  });

  it("treats 'date' as fallback for 'created'", () => {
    const content = "---\ndate: 2026-01-01\n---";
    const result = extractCardinality(content);
    expect(result.created).toBe("2026-01-01");
    expect(result.custom).toEqual({});
  });

  it("collapses custom fields outside first-class set", () => {
    const content = [
      "---",
      "custom1: a",
      "custom2: b",
      "custom3: c",
      "custom4: d",
      "---",
    ].join("\n");
    const result = extractCardinality(content);
    expect(Object.keys(result.custom)).toHaveLength(4);
    expect(result.custom["custom1"]).toBe("a");
  });

  it("handles malformed YAML gracefully — returns {custom: {}}, no throw", () => {
    const malformed = "---\nfoo: [unclosed bracket\n---";
    expect(() => extractCardinality(malformed)).not.toThrow();
    const result = extractCardinality(malformed);
    expect(result).toEqual({ custom: {} });
  });
});

describe("renderCardinalityLine", () => {
  it("returns empty string for empty cardinality", () => {
    expect(renderCardinalityLine({ custom: {} })).toBe("");
  });

  it("renders present first-class fields", () => {
    const line = renderCardinalityLine({
      tags: ["ai", "productivity"],
      status: "active",
      type: "pickup",
      custom: {},
    });
    expect(line).toBe(
      "[tags: ai, productivity | status: active | type: pickup]",
    );
  });

  it("drops empty/missing first-class fields cleanly", () => {
    const line = renderCardinalityLine({
      status: "active",
      custom: {},
    });
    expect(line).toBe("[status: active]");
  });

  it("renders custom fields up to cap=3 then +N more", () => {
    const card: { custom: Record<string, unknown> } = {
      custom: { a: "1", b: "2", c: "3", d: "4", e: "5" },
    };
    const line = renderCardinalityLine(card);
    expect(line).toContain("a: 1");
    expect(line).toContain("b: 2");
    expect(line).toContain("c: 3");
    expect(line).toContain("+2 more");
    expect(line).not.toContain("d: 4");
  });

  it("renders exactly 3 custom fields without +N more", () => {
    const card: { custom: Record<string, unknown> } = {
      custom: { a: "1", b: "2", c: "3" },
    };
    const line = renderCardinalityLine(card);
    expect(line).not.toContain("more");
  });

  it("omits custom fields with empty/null/undefined values", () => {
    const card: { custom: Record<string, unknown> } = {
      custom: { a: "", b: null, c: undefined, d: "real" },
    };
    const line = renderCardinalityLine(card);
    expect(line).toBe("[d: real]");
  });
});

describe("MANAGED_INDEX_MARKER", () => {
  it("is the expected string", () => {
    expect(MANAGED_INDEX_MARKER).toBe("TAPROOT-MANAGED:index");
  });
});
