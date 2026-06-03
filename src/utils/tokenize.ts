/**
 * Shared tokenizer for Pass 3 retrieval (gated by TAPROOT_RETRIEVAL_V2).
 *
 * ONE tokenizer for filename / folder / frontmatter / body scoring, query
 * parsing, and write-time token extraction — replacing the three divergent
 * substring filters that manufactured the IS-7011 false-positive class:
 *   - garden_find `queryWords` (split /\s+/, length>=2, raw .includes)  src/tools/vault.ts
 *   - taproot_harvest `extractKeywords` (length>3 + slice(0,5))         src/tools/knowledge.ts
 *   - scanVaultBodies whole-query substring per line                    src/utils/vault.ts
 *
 * Rules (Pass 3 SPEC §2.1):
 *   1. lowercase
 *   2. split on whitespace AND punctuation  /[\s\p{P}]+/u  (same class harvest used; `_` is Pc)
 *   3. additive letter<->digit split: a token containing BOTH letters and digits
 *      emits the whole token PLUS each maximal letter-run / digit-run
 *      (is7011 -> {is7011, is, 7011}; pr7 -> {pr7, pr, 7}; v2 -> {v2, v, 2}; s62 -> {s62, s, 62})
 *   4. NO length filter (is, it, ai, pr, v2 all survive — RC #3's fix)
 *   5. NO slice cap on query tokens
 *   6. dedup within a single tokenization, first-occurrence order
 *   7. query stopwords are stripped from the QUERY ONLY (never from stored file
 *      tokens), and never when they ARE the entire query.
 *
 * Downstream matching is token-SET equality, never substring — that single
 * property dissolves RC #1 (`is` no longer matches `dec[is]ions`/`analy[s]is`).
 */

// Whitespace + any Unicode punctuation (incl. `_`, category Pc; em-dash, Pd).
const SPLIT_RE = /[\s\p{P}]+/u;

// Maximal runs of digits vs non-digits, in order.
const RUN_RE = /[0-9]+|[^0-9]+/gu;

/**
 * A token is "identifier-shaped" iff it contains a digit (7011, is7011, v2, s62).
 * Used for the scoring precision multiplier and to exempt identifiers from the
 * body-token frequency cap (SPEC §2.2 / §2.4 — never let frequency culling drop
 * `7011`). The short-common demotion is the inverse predicate (length<=2 AND not
 * identifier-shaped).
 */
export function isIdentifierToken(token: string): boolean {
  return /[0-9]/.test(token);
}

/**
 * Function words stripped from QUERIES only. Deliberately EXCLUDES short common
 * tokens that double as real identifiers/acronyms — `is`, `it`, `ai`, `pr`, `v2`
 * are KEPT (their false-positive risk is handled by word-boundary matching + the
 * short-common scoring demotion in SPEC §2.4, not by dropping them). Never
 * contains a token with a digit.
 */
export const QUERY_STOP_WORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "with",
  "by",
  "from",
  "as",
  "into",
  "about",
  "over",
  "under",
  "what",
  "when",
  "where",
  "who",
  "whom",
  "which",
  "why",
  "how",
  "do",
  "does",
  "did",
  "done",
  "was",
  "were",
  "be",
  "been",
  "being",
  "are",
  "this",
  "that",
  "these",
  "those",
  "there",
  "here",
  "i",
  "me",
  "my",
  "we",
  "us",
  "our",
  "you",
  "your",
  "up",
  "out",
  "off",
  "so",
  // Domain filler: in a notes app EVERY item is a "note", so these carry no
  // retrieval signal as part of a multi-word query ("quantum computing notes"
  // → the topic is quantum computing). A bare "note(s)" query still works (the
  // whole-query-stopword fallback keeps it).
  "note",
  "notes",
]);

// Emit letter-run / digit-run sub-tokens, but only for mixed letter+digit tokens.
function splitLetterDigit(token: string): string[] {
  if (!(/[0-9]/.test(token) && /\p{L}/u.test(token))) return [];
  return token.match(RUN_RE) ?? [];
}

// Internal: yield every token in order WITH repeats (no dedup), applying the
// split + additive letter/digit rules. Shared core of tokenize() and
// tokenizeWithCounts() so the split logic lives in exactly one place.
function* rawTokens(text: string): Generator<string> {
  if (!text) return;
  for (const raw of text.toLowerCase().split(SPLIT_RE)) {
    if (!raw) continue;
    yield raw;
    for (const sub of splitLetterDigit(raw)) yield sub;
  }
}

/**
 * Base tokenizer. Pure, deterministic, env-free. Does NOT strip stopwords — use
 * this for file/field tokens (which keep everything) and as the core of query
 * tokenization. Deduped, first-occurrence order.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of rawTokens(text)) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Like tokenize() but returns per-token occurrence counts (no dedup). Drives the
 * body-token frequency cap in extractTokens (SPEC §2.2). Map insertion order is
 * first-occurrence order, matching tokenize().
 */
export function tokenizeWithCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of rawTokens(text)) {
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}

/**
 * Query tokenizer: base tokens minus stopwords. If the query is ENTIRELY
 * stopwords (e.g. a literal search for "the"), the stopwords are kept so the
 * search still runs.
 */
export function tokenizeQuery(text: string): string[] {
  const tokens = tokenize(text);
  const kept = tokens.filter((t) => !QUERY_STOP_WORDS.has(t));
  return kept.length > 0 ? kept : tokens;
}
