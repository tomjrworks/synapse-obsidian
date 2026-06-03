import { describe, it, expect } from "vitest";
import {
  enrichCardinalitySummary,
  extractCardinality,
  extractTokens,
  renderCardinalityLine,
  BODY_TOKEN_CAP,
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

describe("enrichCardinalitySummary", () => {
  it("returns the cardinality unchanged when summary is already populated", () => {
    const card = { summary: "explicit summary", custom: {} };
    const result = enrichCardinalitySummary(card, "# Header\nbody");
    expect(result).toBe(card);
  });

  it("falls back to H1 when no summary field present", () => {
    const card = { custom: {} };
    const result = enrichCardinalitySummary(
      card,
      "---\ntags: [foo]\n---\n# My Note Title\n\nbody text",
    );
    expect(result.summary).toBe("My Note Title");
  });

  it("falls back to first non-heading body line when no summary AND no H1", () => {
    const card = { custom: {} };
    const result = enrichCardinalitySummary(
      card,
      "---\ntags: [foo]\n---\nFirst body line.\nSecond line.",
    );
    expect(result.summary).toBe("First body line.");
  });

  it("strips CRLF frontmatter so body fallback doesn't leak YAML", () => {
    // Regression: a previous regex used \n (LF-only) which left CRLF-style
    // frontmatter unstripped, causing summary to be a YAML line.
    const card = { custom: {} };
    const content =
      "---\r\ntags: [foo]\r\n---\r\nReal body line\r\nSecond line";
    const result = enrichCardinalitySummary(card, content);
    expect(result.summary).toBe("Real body line");
    expect(result.summary).not.toContain("tags");
  });

  it("returns cardinality unchanged when no summary, no H1, and no body content", () => {
    const card = { custom: {} };
    const result = enrichCardinalitySummary(card, "---\ntags: [a]\n---\n");
    expect(result.summary).toBeUndefined();
  });

  it("truncates summary to 200 chars", () => {
    const longLine = "x".repeat(500);
    const card = { custom: {} };
    const result = enrichCardinalitySummary(card, longLine);
    expect(result.summary).toHaveLength(200);
  });
});

describe("extractTokens", () => {
  it("returns empty record for empty content", () => {
    expect(extractTokens("")).toEqual({
      frontmatter: [],
      body: [],
      identifiers: [],
    });
  });

  it("tokenizes title + tags + summary + type into frontmatter", () => {
    const content = [
      "---",
      "title: IS 7011 IT Management",
      "tags: [school, information-systems]",
      "summary: course on competitive advantage",
      "type: course",
      "status: active", // NOT a token field — excluded
      "---",
      "# Body",
    ].join("\n");
    const t = extractTokens(content);
    expect(t.frontmatter).toEqual(
      expect.arrayContaining([
        "is",
        "7011",
        "it",
        "management",
        "school",
        "information",
        "systems",
        "course",
        "competitive",
      ]),
    );
    // status value is not tokenized into frontmatter
    expect(t.frontmatter).not.toContain("active");
  });

  it("tokenizes the body and records identifiers", () => {
    const content = "# Notes\n\nThe IS 7011 syllabus covers v2 of the model.";
    const t = extractTokens(content);
    expect(t.body).toEqual(
      expect.arrayContaining(["syllabus", "covers", "model", "7011", "v2"]),
    );
    expect(t.identifiers).toEqual(expect.arrayContaining(["7011", "v2"]));
    // word-boundary: the substring "is" of nothing here; "is" IS a real token
    expect(t.body).toContain("is");
  });

  it("caps non-identifier body tokens at BODY_TOKEN_CAP but keeps ALL identifiers", () => {
    // 300 distinct letter-only (non-identifier) words + 5 identifiers buried
    // at the end. Each (i%26, i/26) pair is unique for i in 0..299 → distinct.
    const filler = Array.from(
      { length: 300 },
      (_, i) =>
        `lex${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`,
    );
    const idents = ["7011", "s62", "pr9", "v2", "is7011"];
    const content = `# T\n\n${filler.join(" ")} ${idents.join(" ")}`;
    const t = extractTokens(content);
    const nonId = t.body.filter((w) => !/[0-9]/.test(w));
    expect(nonId.length).toBeLessThanOrEqual(BODY_TOKEN_CAP);
    // every identifier survived the cap regardless of frequency/position
    for (const id of idents) expect(t.body).toContain(id);
  });

  it("falls back to body tokens on malformed frontmatter (no recall loss)", () => {
    const malformed = "---\nfoo: [unclosed\n---\nstripe webhook 7011 errors";
    const t = extractTokens(malformed);
    // even though YAML is broken, body recall survives
    expect(t.body).toEqual(
      expect.arrayContaining(["stripe", "webhook", "errors", "7011"]),
    );
    expect(t.identifiers).toContain("7011");
  });
});
