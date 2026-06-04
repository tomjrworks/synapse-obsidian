import { describe, it, expect, afterEach } from "vitest";
import {
  buildIndex,
  type IndexedFile,
} from "../../src/utils/retrieval-index.js";
import { extractTokens } from "../../src/utils/frontmatter.js";
import {
  honestyContractEnabled,
  buildHonestySections,
  renderHonestySections,
  countHonestySections,
  shouldFireHonesty,
  editDistance,
} from "../../src/utils/honesty-contract.js";

// Pure-unit tests for the Pass 2 honesty-contract module. The index is built
// via buildIndex() (ScoringRecord is intentionally unexported) from synthetic
// files, so every token/path the contract can surface provably exists.

function fileFrom(
  p: string,
  body: string,
  fm?: Record<string, unknown>,
): IndexedFile {
  const front = fm
    ? `---\n${Object.entries(fm)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(", ")}]` : v}`)
        .join("\n")}\n---\n`
    : "";
  return { path: p, tokens: extractTokens(`${front}\n${body}`) };
}

// A 6-file synthetic vault with a course folder, a typo target, and identifiers.
const FILES: IndexedFile[] = [
  fileFrom(
    "school/is-7011-it-management/module-1.md",
    "IT competitive advantage and governance",
    { title: "Module 1" },
  ),
  fileFrom(
    "school/is-7011-it-management/module-2.md",
    "Data governance frameworks",
    { title: "Module 2" },
  ),
  fileFrom(
    "decisions/taproot/pricing-model.md",
    "Taproot pricing model freemium kill",
    { title: "Taproot pricing" },
  ),
  fileFrom(
    "projects/taproot/taproot.md",
    "Taproot is the memory layer for AI",
    { title: "Taproot" },
  ),
  fileFrom(
    "daily/2026-05/pr7-stripe-webhook.md",
    "Stripe webhook signature retry shipped",
    { title: "pr7 stripe" },
  ),
  fileFrom("notes/grocery-list.md", "milk eggs bread", { title: "Grocery" }),
  // Combined identifier token `is7011` (from the basename) — the corpus shape
  // that lets a near-miss query `is7012` neighbor it via the shared `is` run.
  fileFrom("daily/2026-05/is7011-case-writeup.md", "course case writeup", {
    title: "is7011 case",
  }),
];
const INDEX = buildIndex(FILES);

describe("editDistance (bounded)", () => {
  it("returns true distance when within budget", () => {
    expect(editDistance("taprot", "taproot", 1)).toBe(1);
    expect(editDistance("kitten", "sitting", 3)).toBe(3);
    expect(editDistance("same", "same", 1)).toBe(0);
  });
  it("early-exits to max+1 when length gap exceeds budget", () => {
    expect(editDistance("a", "abcdef", 1)).toBe(2);
  });
  it("returns max+1 when edits exceed budget", () => {
    expect(editDistance("abcde", "vwxyz", 1)).toBe(2);
  });
});

describe("buildHonestySections", () => {
  afterEach(() => delete process.env.TAPROOT_HONESTY_CONTRACT);

  it("did-you-mean: typo 'taprot' suggests the real token 'taproot'", () => {
    const s = buildHonestySections(INDEX, "taprot", []);
    expect(s.unmatched).toContain("taprot");
    expect(s.didYouMean).toContain("taproot");
  });

  it("related identifiers: 'is7012' surfaces 'is7011'", () => {
    const s = buildHonestySections(INDEX, "is7012", []);
    expect(s.relatedIdentifiers).toContain("is7011");
  });

  it("related folders: a query token in a folder path surfaces the folder", () => {
    const s = buildHonestySections(INDEX, "governance school", []);
    expect(s.relatedFolders.some((f) => f.folder.startsWith("school/"))).toBe(
      true,
    );
  });

  it("closest matches: excludes already-shown paths", () => {
    const shown = ["decisions/taproot/pricing-model.md"];
    const s = buildHonestySections(INDEX, "taproot pricing", shown);
    expect(s.closestMatches.every((m) => !shown.includes(m.path))).toBe(true);
  });

  it("ANTI-CONFABULATION: every suggested token/path/folder exists in the index", () => {
    const vocab = new Set<string>();
    const paths = new Set<string>();
    const folders = new Set<string>();
    for (const f of FILES) {
      paths.add(f.path);
      f.path.split("/").slice(0, -1).join("/") &&
        folders.add(f.path.split("/").slice(0, -1).join("/"));
      const t = f.tokens;
      [...(t.body ?? []), ...(t.frontmatter ?? [])].forEach((x) =>
        vocab.add(x),
      );
    }
    // filename + folder tokens come from the path; add them too
    for (const f of FILES)
      f.path
        .replace(/\.md$/, "")
        .split(/[\s/_-]+/)
        .forEach((x) => vocab.add(x.toLowerCase()));

    // Throw a batch of typo/identifier/real queries and assert no invention.
    for (const q of [
      "taprot",
      "is7012",
      "governnce",
      "striped",
      "pricng",
      "qux zzz",
    ]) {
      const s = buildHonestySections(INDEX, q, []);
      for (const m of s.closestMatches) expect(paths.has(m.path)).toBe(true);
      for (const f of s.relatedFolders)
        expect(folders.has(f.folder)).toBe(true);
      for (const id of s.relatedIdentifiers) expect(vocab.has(id)).toBe(true);
      for (const d of s.didYouMean) expect(vocab.has(d)).toBe(true);
    }
  });

  it("TYPO-ECHO GUARD: never suggests the user's own input token back", () => {
    for (const q of ["taprot", "governnce", "pricng"]) {
      const s = buildHonestySections(INDEX, q, []);
      expect(s.didYouMean).not.toContain(q);
      expect(s.relatedIdentifiers).not.toContain(q);
    }
  });

  it("empty/whitespace query → all sections empty", () => {
    const s = buildHonestySections(INDEX, "   ", []);
    expect(s.queryTokens).toHaveLength(0);
    expect(countHonestySections(s)).toBe(0);
  });

  it("all-stopwords query → no did-you-mean noise", () => {
    const s = buildHonestySections(INDEX, "what when", []);
    expect(s.didYouMean).toHaveLength(0);
  });

  it("caps every section at 3", () => {
    const s = buildHonestySections(INDEX, "is7099", []);
    expect(s.relatedIdentifiers.length).toBeLessThanOrEqual(3);
    expect(s.didYouMean.length).toBeLessThanOrEqual(3);
    expect(s.closestMatches.length).toBeLessThanOrEqual(3);
    expect(s.relatedFolders.length).toBeLessThanOrEqual(3);
  });
});

describe("large-vocab bound (HC9)", () => {
  it("builds sections against a ~5k-file synthetic index and stays capped", () => {
    const big: IndexedFile[] = [];
    for (let i = 0; i < 5000; i++) {
      big.push(
        fileFrom(
          `folder${i % 50}/note-${i}.md`,
          `topic${i % 200} content alpha beta`,
          { title: `n${i}` },
        ),
      );
    }
    const idx = buildIndex(big);
    const s = buildHonestySections(idx, "topix qzzx", []); // typo of topicNNN + a void token
    expect(s.didYouMean.length).toBeLessThanOrEqual(3);
    expect(s.relatedFolders.length).toBeLessThanOrEqual(3);
    expect(s.closestMatches.length).toBeLessThanOrEqual(3);
  });
});

describe("shouldFireHonesty (coverage-based trigger)", () => {
  it("fires on a genuine no-results", () => {
    const s = buildHonestySections(INDEX, "taproot", []);
    expect(shouldFireHonesty(s, true)).toBe(true);
  });
  it("fires when a query token matched nothing, even with results", () => {
    const s = buildHonestySections(INDEX, "taproot quantumzzz", []);
    expect(s.unmatched).toContain("quantumzzz");
    expect(shouldFireHonesty(s, false)).toBe(true);
  });
  it("stays SILENT when all tokens matched and there were results", () => {
    const s = buildHonestySections(INDEX, "taproot pricing", []);
    expect(s.unmatched).toHaveLength(0);
    expect(shouldFireHonesty(s, false)).toBe(false);
  });
  it("stays SILENT on an empty query even if noResults", () => {
    const s = buildHonestySections(INDEX, "   ", []);
    expect(shouldFireHonesty(s, true)).toBe(false);
  });
});

describe("renderHonestySections", () => {
  it("names unmatched terms and lists populated sections", () => {
    const s = buildHonestySections(INDEX, "taprot", []);
    const out = renderHonestySections(s, "taprot");
    expect(out).toContain("Closest context in your vault");
    expect(out).toContain("couldn't match: taprot");
    expect(out).toContain("Did you mean");
  });
  it("falls back to a 'nothing closely related' line on a true void", () => {
    const s = buildHonestySections(INDEX, "qzzx wvvy", []);
    const out = renderHonestySections(s, "qzzx wvvy");
    expect(out).toContain("Closest context in your vault");
    expect(out.toLowerCase()).toContain("nothing closely related");
  });
});

describe("honestyContractEnabled (kill switch)", () => {
  afterEach(() => delete process.env.TAPROOT_HONESTY_CONTRACT);
  it("off by default", () => {
    delete process.env.TAPROOT_HONESTY_CONTRACT;
    expect(honestyContractEnabled()).toBe(false);
  });
  it("on only for exactly '1'", () => {
    process.env.TAPROOT_HONESTY_CONTRACT = "1";
    expect(honestyContractEnabled()).toBe(true);
    process.env.TAPROOT_HONESTY_CONTRACT = "true";
    expect(honestyContractEnabled()).toBe(false);
  });
});
