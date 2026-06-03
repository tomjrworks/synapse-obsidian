import { describe, it, expect, afterEach } from "vitest";
import {
  buildIndex,
  scoreQuery,
  resolveBackfillConcurrency,
  type IndexedFile,
} from "../../src/utils/retrieval-index.js";
import type { FileTokens } from "../../src/utils/frontmatter.js";

// Build an IndexedFile from a path + optional content tokens. Filename/folder
// tokens are derived from the path by buildIndex.
function f(filePath: string, t: Partial<FileTokens> = {}): IndexedFile {
  return {
    path: filePath,
    tokens: {
      frontmatter: t.frontmatter ?? [],
      body: t.body ?? [],
      identifiers: t.identifiers ?? [],
    },
  };
}

const rank = (hits: { path: string }[], p: string) =>
  hits.findIndex((h) => h.path === p);

describe("buildIndex — path-dedup (OFFSET-race duplicate collapse)", () => {
  it("collapses a duplicated path to a single record and does not double-count bodyDf", () => {
    // Same path twice (what an insert-between-OFFSET-pages read yields). Dedup
    // keeps the first → one record, one hit, and df counts the body token once.
    const index = buildIndex([
      f("notes/a.md", { body: ["alpha"] }),
      f("notes/a.md", { body: ["alpha"] }),
      f("notes/b.md", { body: ["beta"] }),
    ]);
    expect(index.n).toBe(2);
    expect(index.bodyDf.get("alpha")).toBe(1);
    expect(scoreQuery(index, "alpha").map((h) => h.path)).toEqual([
      "notes/a.md",
    ]);
  });
});

describe("resolveBackfillConcurrency — RETRIEVAL_BACKFILL_PARALLELISM", () => {
  const prev = process.env.RETRIEVAL_BACKFILL_PARALLELISM;
  afterEach(() => {
    if (prev === undefined) delete process.env.RETRIEVAL_BACKFILL_PARALLELISM;
    else process.env.RETRIEVAL_BACKFILL_PARALLELISM = prev;
  });

  it("defaults to 10 when unset", () => {
    delete process.env.RETRIEVAL_BACKFILL_PARALLELISM;
    expect(resolveBackfillConcurrency()).toBe(10);
  });
  it("honors a valid override", () => {
    process.env.RETRIEVAL_BACKFILL_PARALLELISM = "3";
    expect(resolveBackfillConcurrency()).toBe(3);
  });
  it("falls back to 10 on a non-numeric value", () => {
    process.env.RETRIEVAL_BACKFILL_PARALLELISM = "abc";
    expect(resolveBackfillConcurrency()).toBe(10);
  });
  it("clamps below 1 up to 1 (never zero/negative concurrency)", () => {
    process.env.RETRIEVAL_BACKFILL_PARALLELISM = "0";
    expect(resolveBackfillConcurrency()).toBe(1);
    process.env.RETRIEVAL_BACKFILL_PARALLELISM = "-5";
    expect(resolveBackfillConcurrency()).toBe(1);
  });
});

describe("scoreQuery — word-boundary (RC #1 dissolved)", () => {
  it("a query token does NOT match a filename that merely contains it as a substring", () => {
    const index = buildIndex([
      // "decisions"/"analysis"/"revised" all CONTAIN the substring "is" but
      // none tokenize to the token `is` — they must not match query "is".
      f("daily/2026-05-17-decisions-revised-analysis.md"),
    ]);
    expect(scoreQuery(index, "is")).toEqual([]);
  });

  it("matches the token when it is a real whole token (folder segment)", () => {
    const index = buildIndex([f("school/is-7011-it-management/m1.md")]);
    const hits = scoreQuery(index, "is 7011");
    expect(hits.length).toBe(1);
    expect(hits[0].path).toBe("school/is-7011-it-management/m1.md");
  });
});

describe("scoreQuery — identifier folder hit beats a bare short-token hit", () => {
  it("a folder match on the identifier 7011 outranks a filename match on bare `is`", () => {
    const index = buildIndex([
      f("daily/is-notes.md"), // filename {is, notes} → matches bare `is` only
      f("school/is-7011-it-management/m1.md"), // folder {is, 7011, ...}
    ]);
    const hits = scoreQuery(index, "is 7011");
    // course note (full coverage + identifier ×2) ranks above the bare-`is` note
    expect(hits[0].path).toBe("school/is-7011-it-management/m1.md");
    expect(rank(hits, "school/is-7011-it-management/m1.md")).toBeLessThan(
      rank(hits, "daily/is-notes.md"),
    );
  });

  it("identifier ×2 makes a 7011 hit dominate an `is` hit in the same field", () => {
    const index = buildIndex([
      f("school/7011-course/a.md"), // folder has 7011 (identifier)
      f("school/is-stuff/b.md"), // folder has `is` (short-common)
    ]);
    const hits = scoreQuery(index, "7011 is");
    expect(hits[0].path).toBe("school/7011-course/a.md");
  });
});

describe("scoreQuery — coverage multiplier", () => {
  it("a file matching MORE of the query outranks one matching less", () => {
    const index = buildIndex([
      f("decisions/x.md", {
        body: ["taproot", "pricing", "model", "freemium"],
      }),
      f("decisions/y.md", { body: ["taproot", "notes"] }),
    ]);
    const hits = scoreQuery(index, "taproot pricing");
    expect(hits[0].path).toBe("decisions/x.md");
    expect(rank(hits, "decisions/x.md")).toBeLessThan(
      rank(hits, "decisions/y.md"),
    );
  });
});

describe("scoreQuery — exact basename", () => {
  it("an exact basename token-set match dominates", () => {
    const index = buildIndex([
      f("decisions/taproot-pricing-model.md"),
      f("notes/other.md", { body: ["taproot", "pricing", "model"] }),
    ]);
    const hits = scoreQuery(index, "taproot pricing model");
    expect(hits[0].path).toBe("decisions/taproot-pricing-model.md");
  });
});

describe("scoreQuery — body is in the single ranked pass (RC #2)", () => {
  it("a body-only match is returned (no separate fallback / zero-results gate)", () => {
    const index = buildIndex([
      f("decisions/2026-05-12-taproot-pricing-model.md", {
        body: ["killed", "freemium", "because", "conversion"],
      }),
    ]);
    const hits = scoreQuery(index, "freemium");
    expect(hits.length).toBe(1);
    expect(hits[0].bodyContributed).toBe(true);
  });

  it("bodyContributed is false when the match is filename-only", () => {
    const index = buildIndex([f("notes/freemium.md")]);
    const hits = scoreQuery(index, "freemium");
    expect(hits[0].bodyContributed).toBe(false);
  });
});

describe("scoreQuery — honesty + edges", () => {
  it("returns [] for a query with no corpus match (F1 — no confabulation)", () => {
    const index = buildIndex([
      f("decisions/x.md", { body: ["taproot", "pricing"] }),
    ]);
    expect(scoreQuery(index, "quantum computing notes")).toEqual([]);
  });

  it("returns [] for an empty query", () => {
    const index = buildIndex([f("notes/a.md", { body: ["x"] })]);
    expect(scoreQuery(index, "")).toEqual([]);
  });

  it("honors the limit option", () => {
    const index = buildIndex([
      f("a/taproot.md", { body: ["taproot"] }),
      f("b/taproot.md", { body: ["taproot"] }),
      f("c/taproot.md", { body: ["taproot"] }),
    ]);
    expect(scoreQuery(index, "taproot", { limit: 2 })).toHaveLength(2);
  });
});
