import { describe, it, expect } from "vitest";
import {
  tokenize,
  tokenizeQuery,
  tokenizeWithCounts,
  isIdentifierToken,
  QUERY_STOP_WORDS,
} from "../../src/utils/tokenize.js";

describe("tokenize — word-boundary property (dissolves RC #1)", () => {
  it("does NOT emit `is` for words that merely contain the substring", () => {
    // The exact false-positive set from the IS-7011 bug.
    expect(tokenize("decisions")).not.toContain("is");
    expect(tokenize("analysis")).not.toContain("is");
    expect(tokenize("revised")).not.toContain("is");
    expect(tokenize("session")).not.toContain("is");
  });

  it("does NOT emit a single-char substring of a longer token", () => {
    expect(tokenize("session")).not.toContain("s");
    expect(tokenize("prune")).not.toContain("r");
  });

  it("does NOT emit `it`/`ai`/`pr` for substring-only matches", () => {
    expect(tokenize("competitive")).not.toContain("it");
    expect(tokenize("main")).not.toContain("ai");
    expect(tokenize("again")).not.toContain("ai");
    expect(tokenize("project")).not.toContain("pr");
    expect(tokenize("prune")).not.toContain("pr");
  });

  it("DOES emit the token when it is a real whole token", () => {
    expect(tokenize("is 7011")).toContain("is");
    expect(tokenize("it management")).toContain("it");
    expect(tokenize("ai governance")).toContain("ai");
  });
});

describe("tokenize — identifier letter/digit additive split", () => {
  it("splits is7011 into {is7011, is, 7011}", () => {
    const t = tokenize("is7011");
    expect(t).toContain("is7011");
    expect(t).toContain("is");
    expect(t).toContain("7011");
  });

  it("splits pr7 / v2 / s62 additively (whole + runs)", () => {
    expect(tokenize("pr7")).toEqual(expect.arrayContaining(["pr7", "pr", "7"]));
    expect(tokenize("v2")).toEqual(expect.arrayContaining(["v2", "v", "2"]));
    expect(tokenize("s62")).toEqual(expect.arrayContaining(["s62", "s", "62"]));
  });

  it("hyphenated identifiers split on punctuation (is-7011 -> is, 7011)", () => {
    const t = tokenize("is-7011");
    expect(t).toContain("is");
    expect(t).toContain("7011");
    expect(t).not.toContain("is-7011"); // punctuation split — no joined form
  });

  it("pure-letter and pure-digit tokens are not split", () => {
    expect(tokenize("management")).toEqual(["management"]);
    expect(tokenize("7011")).toEqual(["7011"]);
  });
});

describe("tokenize — no length filter, no slice cap", () => {
  it("keeps short tokens is/it/ai/pr (RC #3's fix)", () => {
    expect(tokenize("is it ai pr")).toEqual(
      expect.arrayContaining(["is", "it", "ai", "pr"]),
    );
  });

  it("keeps more than 5 tokens (no slice(0,5))", () => {
    expect(tokenize("one two three four five six seven")).toHaveLength(7);
  });
});

describe("tokenize — splitting + normalization", () => {
  it("lowercases", () => {
    expect(tokenize("IS 7011")).toEqual(expect.arrayContaining(["is", "7011"]));
  });

  it("splits on whitespace and punctuation incl. underscore and slash", () => {
    expect(tokenize("stripe/webhook_errors")).toEqual(
      expect.arrayContaining(["stripe", "webhook", "errors"]),
    );
  });

  it("dedups within one tokenization, first-occurrence order preserved", () => {
    expect(tokenize("ai ai governance ai")).toEqual(["ai", "governance"]);
  });

  it("returns [] for empty / whitespace-only / punctuation-only input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
    expect(tokenize("—")).toEqual([]); // em-dash only
  });
});

describe("tokenizeQuery — stopwords stripped from query only", () => {
  it("strips function words from a natural-language query", () => {
    expect(tokenizeQuery("what was i working on this week")).toEqual([
      "working",
      "week",
    ]);
  });

  it("keeps the stopword when it IS the entire query", () => {
    expect(tokenizeQuery("the")).toEqual(["the"]);
    expect(tokenizeQuery("of")).toEqual(["of"]);
    expect(tokenizeQuery("notes")).toEqual(["notes"]); // bare query still works
  });

  it("strips the domain-filler word `notes` from a multi-word query", () => {
    expect(tokenizeQuery("quantum computing notes")).toEqual([
      "quantum",
      "computing",
    ]);
  });

  it("does NOT strip short identifiers/acronyms (is, it, ai, pr)", () => {
    expect(tokenizeQuery("is 7011")).toContain("is");
    expect(tokenizeQuery("AI")).toEqual(["ai"]);
    expect(tokenizeQuery("PR")).toEqual(["pr"]);
  });

  it("base tokenize() never strips stopwords (file tokens keep everything)", () => {
    expect(tokenize("what was i working on this week")).toEqual(
      expect.arrayContaining(["what", "was", "i", "on", "this"]),
    );
  });

  it("stopword set never contains an identifier-shaped token", () => {
    for (const w of QUERY_STOP_WORDS) {
      expect(isIdentifierToken(w)).toBe(false);
    }
  });
});

describe("isIdentifierToken", () => {
  it("is true for tokens containing a digit", () => {
    expect(isIdentifierToken("7011")).toBe(true);
    expect(isIdentifierToken("is7011")).toBe(true);
    expect(isIdentifierToken("v2")).toBe(true);
    expect(isIdentifierToken("s62")).toBe(true);
  });

  it("is false for pure-letter tokens", () => {
    expect(isIdentifierToken("is")).toBe(false);
    expect(isIdentifierToken("management")).toBe(false);
    expect(isIdentifierToken("ai")).toBe(false);
  });
});

describe("tokenizeWithCounts — frequency map (drives body cap)", () => {
  it("counts occurrences without deduping", () => {
    const counts = tokenizeWithCounts("ai ai ai governance");
    expect(counts.get("ai")).toBe(3);
    expect(counts.get("governance")).toBe(1);
  });

  it("counts additive sub-tokens too", () => {
    const counts = tokenizeWithCounts("is7011 is7011");
    expect(counts.get("is7011")).toBe(2);
    expect(counts.get("is")).toBe(2);
    expect(counts.get("7011")).toBe(2);
  });

  it("keys match tokenize() (same split rules), counts >= 1", () => {
    const text = "stripe webhook errors stripe";
    const keys = [...tokenizeWithCounts(text).keys()];
    expect(keys).toEqual(tokenize(text)); // first-occurrence order preserved
  });

  it("returns an empty map for empty input", () => {
    expect(tokenizeWithCounts("").size).toBe(0);
  });
});
