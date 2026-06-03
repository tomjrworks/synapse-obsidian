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
]);

// Emit letter-run / digit-run sub-tokens, but only for mixed letter+digit tokens.
function splitLetterDigit(token: string): string[] {
  if (!(/[0-9]/.test(token) && /\p{L}/u.test(token))) return [];
  return token.match(RUN_RE) ?? [];
}

/**
 * Base tokenizer. Pure, deterministic, env-free. Does NOT strip stopwords — use
 * this for file/field tokens (which keep everything) and as the core of query
 * tokenization.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string): void => {
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  for (const raw of text.toLowerCase().split(SPLIT_RE)) {
    if (!raw) continue;
    push(raw);
    for (const sub of splitLetterDigit(raw)) push(sub);
  }
  return out;
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
