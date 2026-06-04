import path from "node:path";
import {
  tokenizeQuery,
  isIdentifierToken,
  QUERY_STOP_WORDS,
} from "./tokenize.js";
import { scoreQuery, type RetrievalIndex } from "./retrieval-index.js";

/**
 * Pass 2 — the honesty contract (SPEC 2026-06-03-pass-2-honesty-contract-spec).
 *
 * Pure, synchronous, no I/O. Given the Pass 3 retrieval index, the query, and
 * the paths the handler is about to show, it computes up to four honest helper
 * sections for a thin/no-result response and renders them as a markdown block.
 *
 * DECOUPLED from the ranking flag (SPEC §5-RESOLVED): the index this reads from
 * (`getRetrievalIndex` → `buildIndex` over extracted_tokens) exists independent
 * of whether the V1 or V2 scorer runs, so the contract protects the rollback
 * (V1) path too — the confabulation floor the roadmap's Pass-2-before-Pass-3
 * sequence was insurance for.
 *
 * Anti-confabulation invariant: every suggested token / path / folder is read
 * directly OUT of the index. The contract can only surface things that
 * demonstrably exist in the vault — it never synthesizes a name.
 *
 * Kill switch: TAPROOT_HONESTY_CONTRACT=1 (global, default OFF).
 */

const SECTION_CAP = 3; // ≤3 items per section
const DYM_MIN_LEN = 4; // did-you-mean only for query tokens this long or longer
const DYM_LONG_LEN = 7; // tokens ≥ this get edit-distance budget 2 instead of 1

export function honestyContractEnabled(): boolean {
  return process.env.TAPROOT_HONESTY_CONTRACT === "1";
}

export interface HonestySections {
  /** Query tokens (post-stopword) — empty for a blank/all-punctuation query. */
  queryTokens: string[];
  /** Query tokens that appear in NO field of ANY indexed file. */
  unmatched: string[];
  closestMatches: { path: string; score: number }[];
  relatedFolders: { folder: string; fileCount: number }[];
  relatedIdentifiers: string[];
  didYouMean: string[];
}

/** Maximal runs of digits vs non-digits, in order (mirrors tokenize's RUN_RE).
 * Exported (Pass 4a) so garden_identifier shares ONE run-splitter — its
 * related-id suggestion loop duplicates the ~6-line matcher (audit decision:
 * export-only, do NOT refactor relatedIdentifiers out of the shipped file). */
const RUN_RE = /[0-9]+|[^0-9]+/gu;
export function runsOf(token: string): string[] {
  return token.match(RUN_RE) ?? [];
}

/**
 * Bounded Levenshtein: returns the true distance if ≤ max, else max+1. Early
 * exits once a whole row provably exceeds max, so cost is O(len * (max+1)) not
 * O(len²). Callers prefilter on the length band so this only runs on plausible
 * near-neighbors.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Single pass over index.files: full vocabulary (token → document frequency
 * across ALL fields), the identifier subset, and per-folder token sets + counts.
 * Built lazily inside buildHonestySections (miss/thin path only).
 */
interface IndexDerived {
  vocab: Map<string, number>;
  folders: Map<string, { tokens: Set<string>; count: number }>;
}
function deriveFromIndex(index: RetrievalIndex): IndexDerived {
  const vocab = new Map<string, number>();
  const folders = new Map<string, { tokens: Set<string>; count: number }>();
  for (const rec of index.files) {
    const fileTokens = new Set<string>([
      ...rec.filename,
      ...rec.frontmatter,
      ...rec.folder,
      ...rec.body,
    ]);
    for (const t of fileTokens) vocab.set(t, (vocab.get(t) ?? 0) + 1);
    const dir = path.dirname(rec.path);
    if (dir !== ".") {
      const agg = folders.get(dir);
      if (agg) agg.count += 1;
      else folders.set(dir, { tokens: new Set(rec.folder), count: 1 });
    }
  }
  return { vocab, folders };
}

export function buildHonestySections(
  index: RetrievalIndex,
  query: string,
  shownPaths: string[],
): HonestySections {
  const queryTokens = tokenizeQuery(query);
  const empty: HonestySections = {
    queryTokens,
    unmatched: [],
    closestMatches: [],
    relatedFolders: [],
    relatedIdentifiers: [],
    didYouMean: [],
  };
  if (queryTokens.length === 0) return empty;

  const { vocab, folders } = deriveFromIndex(index);
  const qSet = new Set(queryTokens);
  const unmatched = queryTokens.filter((t) => !vocab.has(t));

  // ── Closest matches: sub-threshold scored hits not already shown ──
  const shown = new Set(shownPaths);
  const closestMatches = scoreQuery(index, query)
    .filter((hit) => !shown.has(hit.path))
    .slice(0, SECTION_CAP)
    .map((hit) => ({ path: hit.path, score: hit.score }));

  // ── Related folders: folder token-set intersects the query ──
  const relatedFolders = [...folders.entries()]
    .map(([folder, agg]) => {
      let overlap = 0;
      for (const t of qSet) if (agg.tokens.has(t)) overlap += 1;
      return { folder, fileCount: agg.count, overlap };
    })
    .filter((f) => f.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || b.fileCount - a.fileCount)
    .slice(0, SECTION_CAP)
    .map(({ folder, fileCount }) => ({ folder, fileCount }));

  // ── Related identifiers: vault identifier tokens sharing a run with an
  //    unmatched identifier-shaped query token (is7012 → is7011). ──
  const identifierVocab = [...vocab.keys()].filter(isIdentifierToken);
  const relatedIdentifiers: string[] = [];
  const seenId = new Set<string>();
  for (const qt of unmatched.filter(isIdentifierToken)) {
    const qRuns = new Set(runsOf(qt));
    const cands = identifierVocab
      .filter(
        (c) =>
          c !== qt && !seenId.has(c) && runsOf(c).some((r) => qRuns.has(r)),
      )
      .sort((a, b) => (vocab.get(b) ?? 0) - (vocab.get(a) ?? 0));
    for (const c of cands.slice(0, SECTION_CAP)) {
      relatedIdentifiers.push(c);
      seenId.add(c);
    }
  }

  // ── Did you mean: bounded edit-distance neighbors for unmatched, non-stopword,
  //    non-identifier query tokens of length ≥ DYM_MIN_LEN. ──
  const didYouMean: string[] = [];
  const seenDym = new Set<string>();
  const vocabList = [...vocab.keys()];
  for (const qt of unmatched) {
    if (qt.length < DYM_MIN_LEN) continue;
    if (QUERY_STOP_WORDS.has(qt)) continue;
    if (isIdentifierToken(qt)) continue;
    const maxDist = qt.length >= DYM_LONG_LEN ? 2 : 1;
    const cands = vocabList
      .filter(
        (c) =>
          c !== qt &&
          !seenDym.has(c) &&
          !isIdentifierToken(c) &&
          Math.abs(c.length - qt.length) <= maxDist &&
          editDistance(qt, c, maxDist) <= maxDist,
      )
      .sort((a, b) => (vocab.get(b) ?? 0) - (vocab.get(a) ?? 0));
    for (const c of cands.slice(0, SECTION_CAP)) {
      didYouMean.push(c);
      seenDym.add(c);
    }
  }

  return {
    queryTokens,
    unmatched,
    closestMatches,
    relatedFolders,
    relatedIdentifiers: relatedIdentifiers.slice(0, SECTION_CAP),
    didYouMean: didYouMean.slice(0, SECTION_CAP),
  };
}

/** Count of the four actionable sections that are non-empty (telemetry flag). */
export function countHonestySections(s: HonestySections): number {
  return (
    (s.closestMatches.length > 0 ? 1 : 0) +
    (s.relatedFolders.length > 0 ? 1 : 0) +
    (s.relatedIdentifiers.length > 0 ? 1 : 0) +
    (s.didYouMean.length > 0 ? 1 : 0)
  );
}

/** Should the contract fire for this result? Coverage-based, NOT count-based:
 * a query that returns few but fully-matched results is good, not thin. */
export function shouldFireHonesty(
  s: HonestySections,
  noResults: boolean,
): boolean {
  return s.queryTokens.length > 0 && (noResults || s.unmatched.length > 0);
}

const HONESTY_HEADER = "Closest context in your vault";

/**
 * Render the block. Only call when shouldFireHonesty is true. Always returns a
 * non-empty string (the header alone is the honest "low-confidence" signal);
 * names the unmatched terms, lists whichever sections populated, and falls back
 * to an explicit "nothing closely related" line on a true void so the model
 * doesn't confabulate. Paths/tokens only — no vault BODY content echoed, so no
 * untrusted-content fence is needed.
 */
export function renderHonestySections(
  s: HonestySections,
  query: string,
): string {
  const qualifier = s.unmatched.length
    ? `couldn't match: ${s.unmatched.join(", ")}`
    : `no strong match for "${query}"`;
  const lines = [`> **${HONESTY_HEADER}** (${qualifier}):`];
  let any = false;
  if (s.didYouMean.length) {
    lines.push(`> - **Did you mean:** ${s.didYouMean.join(", ")}`);
    any = true;
  }
  if (s.relatedIdentifiers.length) {
    lines.push(
      `> - **Related identifiers:** ${s.relatedIdentifiers.join(", ")}`,
    );
    any = true;
  }
  if (s.relatedFolders.length) {
    lines.push(
      `> - **Related folders:** ${s.relatedFolders
        .map(
          (f) =>
            `${f.folder} (${f.fileCount} ${f.fileCount === 1 ? "note" : "notes"})`,
        )
        .join(", ")}`,
    );
    any = true;
  }
  if (s.closestMatches.length) {
    lines.push(
      `> - **Closest matches:** ${s.closestMatches.map((m) => m.path).join(", ")}`,
    );
    any = true;
  }
  if (!any) {
    lines.push(
      "> Nothing closely related found — this topic may genuinely not be in the vault yet. Don't fabricate an answer; tell the user it isn't saved.",
    );
  }
  return lines.join("\n");
}
