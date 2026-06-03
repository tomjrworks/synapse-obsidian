import path from "node:path";
import { tokenize, tokenizeQuery, isIdentifierToken } from "./tokenize.js";
import { extractTokens, type FileTokens } from "./frontmatter.js";
import type { StorageBackend } from "./storage.js";

/**
 * Pure, backend-agnostic inverted index + blended scorer for Pass 3 retrieval
 * (SPEC §2.3 / §2.4). This module is the SINGLE source of ranking truth — the
 * eval harness unit-tests it directly, and garden_find / garden_forage /
 * taproot_harvest all call scoreQuery() under TAPROOT_RETRIEVAL_V2.
 *
 * Matching is token-SET equality, never substring (RC #1). Filename + folder
 * tokens are derived from the LIVE path at build time (move-safe — a rename can
 * never leave stale filename tokens behind); frontmatter/body/identifiers come
 * from the stored content tokens (extractTokens → extracted_tokens column).
 */

// Cohort allowlist (decision 2026-06-03-pass-3-cohort-flag-rollout, Option A).
// Parsed live from TAPROOT_RETRIEVAL_V2_WORKSPACES on every call (so a redeploy
// with a changed list takes effect immediately) but the split is memoized on the
// raw string — re-parse only when the env value actually changes.
let cohortRaw: string | undefined;
let cohortSet = new Set<string>();
function retrievalV2Cohort(): Set<string> {
  const raw = process.env.TAPROOT_RETRIEVAL_V2_WORKSPACES ?? "";
  if (raw !== cohortRaw) {
    cohortRaw = raw;
    cohortSet = new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
  return cohortSet;
}

/** The Pass 3 kill switch. Resolved once at handler entry (like resolveScanCap).
 * Off = V1 behavior byte-for-byte; on = the V2 blended ranked pass.
 *
 * Resolution order (CONCERN #2 fix — per-workspace rollout):
 *   1. global TAPROOT_RETRIEVAL_V2=1 → ON for everyone (override + stdio default).
 *   2. else perWorkspaceEnabled (Option B — workspaces.settings.retrieval_v2,
 *      resolved + cached by retrievalV2Setting) → ON for that workspace.
 *   3. else workspaceId ∈ TAPROOT_RETRIEVAL_V2_WORKSPACES (Option A — allowlist
 *      env) → ON for that cohort.
 *   4. else OFF.
 * Pure + synchronous: the per-workspace bool is resolved upstream (server.ts)
 * and passed in, so handlers stay non-async on the flag check. Passing neither
 * arg (local/stdio path) collapses to the global flag only. */
export function retrievalV2Enabled(
  workspaceId?: string,
  perWorkspaceEnabled?: boolean,
): boolean {
  if (process.env.TAPROOT_RETRIEVAL_V2 === "1") return true;
  if (perWorkspaceEnabled === true) return true;
  return workspaceId != null && retrievalV2Cohort().has(workspaceId);
}

export interface IndexedFile {
  path: string;
  tokens: FileTokens; // content tokens (frontmatter / body / identifiers)
}

interface ScoringRecord {
  path: string;
  filename: Set<string>; // tokens of the basename (no extension)
  folder: Set<string>; // tokens of the folder path
  frontmatter: Set<string>;
  body: Set<string>;
}

export interface RetrievalIndex {
  files: ScoringRecord[];
  bodyDf: Map<string, number>; // document frequency over BODY tokens (for IDF)
  n: number; // total indexed files
}

export interface ScoredHit {
  path: string;
  score: number;
  /** Query tokens that matched anywhere in the file (drives coverage telemetry). */
  matchedTokens: string[];
  /** Whether ≥1 body-token contribution entered the score (the V2 re-interpretation
   * of body_fallback_fired). */
  bodyContributed: boolean;
}

export interface ScoreOptions {
  limit?: number;
}

// SPEC §2.4 weight table. Numbers are TUNABLE (finalized against the eval set in
// C8/VERIFY after the V1 floor is known); the STRUCTURE is locked.
export const WEIGHTS = {
  basenameExact: 100,
  filename: 10,
  frontmatter: 8,
  folder: 6,
  body: 4, // × IDF rarity factor
};
const IDENTIFIER_MULTIPLIER = 2.0; // §2.4 — identifier-shaped query token contributions
const SHORT_COMMON_MULTIPLIER = 0.4; // §2.4 — length<=2, non-identifier query tokens

// IDF (Part 0 item 3): log(1 + N/(1+df)). 1+ in num & denom → never div-by-zero,
// never negative, smooth. Applied only to the body-token weight.
function idf(df: number, n: number): number {
  return Math.log(1 + n / (1 + df));
}

function fieldsFromPath(p: string): { filename: string[]; folder: string[] } {
  const basename = path.basename(p, ".md");
  const dir = path.dirname(p);
  return {
    filename: tokenize(basename),
    // tokenize() splits on `/` (punctuation), so folder segments fall out.
    folder: dir === "." ? [] : tokenize(dir),
  };
}

/**
 * Assemble the inverted index from per-file content tokens. Pure. Filename and
 * folder token sets are derived from each file's path here.
 */
export function buildIndex(files: IndexedFile[]): RetrievalIndex {
  const records: ScoringRecord[] = [];
  const bodyDf = new Map<string, number>();

  for (const { path: filePath, tokens } of files) {
    const { filename, folder } = fieldsFromPath(filePath);
    const body = new Set(tokens.body ?? []);
    records.push({
      path: filePath,
      filename: new Set(filename),
      folder: new Set(folder),
      frontmatter: new Set(tokens.frontmatter ?? []),
      body,
    });
    // document frequency: count each distinct body token once per file
    for (const t of body) bodyDf.set(t, (bodyDf.get(t) ?? 0) + 1);
  }

  return { files: records, bodyDf, n: records.length };
}

function setEquals(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size || a.size === 0) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Score every file against the query and return hits ordered by descending
 * score (ties broken by path for determinism). Word-boundary token-set matching
 * only; body signal is part of the single ranked pass (no separate fallback).
 */
export function scoreQuery(
  index: RetrievalIndex,
  query: string,
  opts: ScoreOptions = {},
): ScoredHit[] {
  const qTokens = tokenizeQuery(query);
  if (qTokens.length === 0) return [];
  const qSet = new Set(qTokens);

  const hits: ScoredHit[] = [];
  for (const rec of index.files) {
    let score = 0;
    let matchedCount = 0;
    let bodyContributed = false;
    const matchedTokens: string[] = [];

    // Exact basename: tokens(basename) set-equals the query token set (+100).
    if (setEquals(rec.filename, qSet)) score += WEIGHTS.basenameExact;

    for (const qt of qTokens) {
      let contrib = 0;
      let matchedHere = false;

      if (rec.filename.has(qt)) {
        contrib += WEIGHTS.filename;
        matchedHere = true;
      }
      if (rec.frontmatter.has(qt)) {
        contrib += WEIGHTS.frontmatter;
        matchedHere = true;
      }
      if (rec.folder.has(qt)) {
        contrib += WEIGHTS.folder;
        matchedHere = true;
      }
      if (rec.body.has(qt)) {
        contrib += WEIGHTS.body * idf(index.bodyDf.get(qt) ?? 0, index.n);
        matchedHere = true;
        bodyContributed = true;
      }

      if (matchedHere) {
        const isId = isIdentifierToken(qt);
        if (isId) contrib *= IDENTIFIER_MULTIPLIER;
        else if (qt.length <= 2) contrib *= SHORT_COMMON_MULTIPLIER;
        score += contrib;
        matchedCount += 1;
        matchedTokens.push(qt);
      }
    }

    if (score <= 0) continue;

    // Coverage multiplier (Part 0 item 4): 0.5 + 0.5 * (fraction matched).
    const coverage = matchedCount / qTokens.length;
    score *= 0.5 + 0.5 * coverage;

    hits.push({ path: rec.path, score, matchedTokens, bodyContributed });
  }

  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return opts.limit != null ? hits.slice(0, opts.limit) : hits;
}

// ─────────────────────────────────────────────────────────────────────────
// Per-backend cached assembly (SPEC §2.3 — mirrors indexCache in index-tool).
// The index is rebuilt from listFilesMeta; invalidated on the same debounced
// flush that rebuilds index.md (wired in C5 via index-tool's flush hook).
// ─────────────────────────────────────────────────────────────────────────

const RETRIEVAL_INDEX_TTL_MS = 60 * 60 * 1000;

interface RetrievalCacheEntry {
  index: RetrievalIndex;
  cachedAt: number;
}

const retrievalIndexCache = new WeakMap<StorageBackend, RetrievalCacheEntry>();

/** Drop the cached retrieval index for a backend. Called from the index flush. */
export function invalidateRetrievalIndex(backend: StorageBackend): void {
  retrievalIndexCache.delete(backend);
}

/**
 * Get (or build + cache) the retrieval index for a backend. Reads all file
 * tokens via the UNCAPPED listFileTokensMeta (Path B) — so a vault >1000 files
 * is fully reachable, not silently truncated to the first 1000 like the index.md
 * map. Falls back to listFilesMeta on backends/mocks that don't implement the
 * uncapped reader.
 *
 * Files whose tokens haven't been backfilled yet (null) are skipped from the
 * index AND collected for a fire-and-forget full-vault backfill: a partially
 * populated column yields fewer hits (never WRONG rankings), and the backfill
 * drains the gap in the background so subsequent reads are complete. This is the
 * self-healing path; the deploy-time warm (a no-op write → flush →
 * getRetrievalIndex) populates the whole column before the read flag flips.
 */
export async function getRetrievalIndex(
  backend: StorageBackend,
): Promise<RetrievalIndex> {
  const cached = retrievalIndexCache.get(backend);
  if (cached && Date.now() - cached.cachedAt < RETRIEVAL_INDEX_TTL_MS) {
    return cached.index;
  }
  const meta = backend.listFileTokensMeta
    ? await backend.listFileTokensMeta()
    : await backend.listFilesMeta();
  const files: IndexedFile[] = [];
  const nullTokenPaths: string[] = [];
  for (const m of meta) {
    if (m.tokens) files.push({ path: m.path, tokens: m.tokens });
    else nullTokenPaths.push(m.path);
  }
  const index = buildIndex(files);
  retrievalIndexCache.set(backend, { index, cachedAt: Date.now() });
  if (nullTokenPaths.length > 0) {
    void backfillNullTokens(backend, nullTokenPaths).catch((err) =>
      console.error(`[retrieval] token backfill failed: ${err}`),
    );
  }
  return index;
}

// Guards against a flush-triggered warm and a concurrent read both backfilling
// the same backend at once (duplicate blob reads). The .is(null) write-side
// race-guard already makes the WRITES idempotent; this avoids the wasted reads.
const tokenBackfillInFlight = new WeakSet<StorageBackend>();

/**
 * Read + extract + persist tokens for files whose extracted_tokens column is
 * null (the migration-day cold tail, and anything past the old 1000 cap). This
 * is the ONE expensive path — it reads file content (encrypted blobs on
 * Supabase) — so it is:
 *   - one-time per file (the column is null exactly once, ever),
 *   - fire-and-forget (never blocks a user query),
 *   - chunked (concurrency 10), and
 *   - in-flight-guarded (no concurrent duplicate runs per backend).
 * Identical cost shape to the extracted_cardinality backfill that already
 * shipped. On success it drops the cached (partial) index so the next read
 * rebuilds with the freshly-populated tokens.
 */
export async function backfillNullTokens(
  backend: StorageBackend,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  if (!backend.batchUpdateTokens) return;
  if (tokenBackfillInFlight.has(backend)) return;
  tokenBackfillInFlight.add(backend);
  try {
    const concurrency = 10;
    const updates = new Map<string, FileTokens>();
    for (let i = 0; i < paths.length; i += concurrency) {
      const chunk = paths.slice(i, i + concurrency);
      await Promise.all(
        chunk.map(async (p) => {
          try {
            updates.set(p, extractTokens(await backend.readFile(p)));
          } catch {
            // Unreadable (e.g. deleted mid-flight) — skip; never abort the run.
          }
        }),
      );
    }
    if (updates.size > 0) {
      await backend.batchUpdateTokens(updates);
      invalidateRetrievalIndex(backend);
    }
  } finally {
    tokenBackfillInFlight.delete(backend);
  }
}

/** Test seam — reset the WeakMap entry between cases that reuse a backend ref. */
export function _clearRetrievalIndexCache(backend: StorageBackend): void {
  retrievalIndexCache.delete(backend);
}
