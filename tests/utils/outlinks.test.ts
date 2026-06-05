import { describe, it, expect } from "vitest";
import {
  linkKey,
  outlinkKeys,
  extractOutlinks,
} from "../../src/utils/outlinks.js";

// ─────────────────────────────────────────────────────────────────────────
// Pass 4b — extractOutlinks (the write-time half of garden_backlinks v2). This
// is the producer of the stored `extracted_outlinks` column; the precision of
// the whole tool rides on it: ONLY a literal [[…]] edge counts, resolution is
// symmetric with the target side (alias + heading stripped), and the output is
// a sorted/deduped key set. RED baseline: extractOutlinks is a stub returning
// [] until implemented.
// ─────────────────────────────────────────────────────────────────────────

describe("linkKey — symmetric resolution", () => {
  it("OL-K1 — strips |alias and #heading, takes basename, slugs", () => {
    expect(linkKey("module-1-it-competitive-advantage")).toBe(
      "module-1-it-competitive-advantage",
    );
    expect(linkKey("module-1-it-competitive-advantage|Module 1")).toBe(
      "module-1-it-competitive-advantage",
    );
    expect(linkKey("module-1-it-competitive-advantage#Frameworks")).toBe(
      "module-1-it-competitive-advantage",
    );
    expect(
      linkKey(
        "school/is-7011-it-management/module-1-it-competitive-advantage.md",
      ),
    ).toBe("module-1-it-competitive-advantage");
    expect(linkKey("Module 1")).toBe("module-1");
  });
});

describe("outlinkKeys — only literal [[…]] edges", () => {
  it("OL-K2 — extracts deduped wikilink target keys, ignores prose", () => {
    const body = [
      "Links [[alpha]] and [[beta|Beta]] and again [[alpha]].",
      "Prose mention of gamma is not a link.",
    ].join("\n");
    expect([...outlinkKeys(body)].sort()).toEqual(["alpha", "beta"]);
  });
});

describe("extractOutlinks — stored column producer", () => {
  it("OL1 — plain + alias + heading links resolve to sorted deduped keys", () => {
    const content = [
      "---",
      "title: Note",
      "---",
      "# Note",
      "Builds on [[module-1|Module 1]] and [[module-1#Frameworks]].",
      "See also [[module-2-data-governance]].",
    ].join("\n");
    expect(extractOutlinks(content)).toEqual([
      "module-1",
      "module-2-data-governance",
    ]);
  });

  it("OL2 — a note with NO wikilinks yields an empty array (orphan source)", () => {
    const content = [
      "---",
      "title: Recap",
      "---",
      "Module 1 it competitive advantage — prose only, no link here.",
    ].join("\n");
    expect(extractOutlinks(content)).toEqual([]);
  });

  it("OL3 — links in frontmatter are edges too (whole-content scan)", () => {
    const content = [
      "---",
      "title: Index",
      "related: '[[alpha]]'",
      "---",
      "Body links [[beta]].",
    ].join("\n");
    expect(extractOutlinks(content)).toEqual(["alpha", "beta"]);
  });

  it("OL4 — pure prose is never a false edge (precision)", () => {
    expect(extractOutlinks("just words, no brackets at all")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// H1 (security-audit) — write-path O(n²) regex DoS. extractOutlinks runs
// UNCONDITIONALLY in writeFile on every sync; a `[`-run drives the old
// /\[\[([^\]]+?)\]\]/g into quadratic backtracking (the negated class matches
// `[`). This bound is TIME-BOXED on purpose: a correctness-only eval stays
// GREEN on the broken regex, which is exactly why the build-audit missed it.
// RED on b79cdb0 (blocks ~45s synchronously, then the elapsed assert fails);
// GREEN after the char-class tighten (<1ms).
// ─────────────────────────────────────────────────────────────────────────
describe("extractOutlinks — H1 write-path DoS bound", () => {
  it("OL-PERF — a 500k-`[` body returns under 100ms (no O(n²) blowup)", () => {
    const body = "[".repeat(500_000);
    const start = performance.now();
    const out = extractOutlinks(body);
    const elapsed = performance.now() - start;
    expect(out).toEqual([]); // a bare `[`-run has no valid [[…]] edge
    expect(elapsed).toBeLessThan(100);
  }, 60_000); // generous so the FAILURE is the perf assert, not a vitest timeout

  it("OL-PERF-2 — tightened regex preserves every real-link shape (behavior-preserving)", () => {
    expect(extractOutlinks("[[alpha]]")).toEqual(["alpha"]);
    expect(extractOutlinks("[[alpha|Alpha display]]")).toEqual(["alpha"]);
    expect(extractOutlinks("[[alpha#Heading]]")).toEqual(["alpha"]);
    expect(
      extractOutlinks("see [[alpha]] then [[beta]] and [[alpha]] again"),
    ).toEqual(["alpha", "beta"]);
    expect(extractOutlinks("[[module 1 spaces]]")).toEqual(["module-1-spaces"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// C1 (build-audit) — a [[wikilink]] inside a ``` / ~~~ code fence or an inline
// `code` span is NOT a real edge (Tom's engineering vault quotes wikilink
// syntax in code blocks). Precision ship-bar = zero false edges. RED on
// b79cdb0 (no fence stripping); GREEN after outlinkKeys strips code spans.
// ─────────────────────────────────────────────────────────────────────────
describe("extractOutlinks — C1 code-span exclusion", () => {
  it("OL-FENCE — wikilinks inside fenced/inline code are not edges; real links still resolve", () => {
    const body = [
      "Real link [[live-link]] in prose.",
      "```",
      "code with [[fenced-link]] inside a backtick fence",
      "```",
      "~~~",
      "tilde fence with [[tilde-link]]",
      "~~~",
      "Inline `[[code-link]]` span is not an edge either.",
    ].join("\n");
    expect(extractOutlinks(body)).toEqual(["live-link"]);
  });
});
