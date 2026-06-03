// ─────────────────────────────────────────────────────────────────────────
// Synthetic-vault fixtures for the Pass 3 retrieval harness — the SHAPES Tom's
// own ~1432-file vault cannot produce (handoff 2026-06-03-pass-3-c9-c10-review):
//
//   (a) OVERSIZED vault (5k / 15k files) — exercises the uncapped
//       listFileTokensMeta reader past row 1000 at real scale, and a backfill
//       that outruns the 5-min backend LRU TTL (the per-instance in-flight
//       WeakSet guard's lifetime).
//   (b) CONCURRENT MUTATION during pagination — a write/delete landing between
//       OFFSET page reads (the .range() race).
//
// Tom IS the eval fixture for the in-memory A/B harness (corpus.ts). Single-user
// dogfooding is structurally blind to load + race shapes that only appear on a
// vault that ISN'T his. These helpers manufacture those shapes deterministically.
//
// SharedVaultStore mirrors the Supabase backend's two race-relevant primitives
// FAITHFULLY (verified against src/utils/supabase-mirror.ts):
//   • listFileTokensMeta — PAGE=1000, .order("path") ASC, .range(from, from+PAGE-1)
//     looping from += PAGE, break when rows.length < PAGE. We re-slice the LIVE
//     ordered store on every page, so a mutation between pages shifts the OFFSET
//     window exactly like a real concurrent table mutation does (supabase-mirror.ts:603-624).
//   • batchUpdateTokens — strict null-fill: only writes where the column is
//     currently null (the `.is("extracted_tokens", null)` write-guard at
//     supabase-mirror.ts:679). This is what makes a double backfill non-corrupting.
// ─────────────────────────────────────────────────────────────────────────

import type { FileMeta, StorageBackend } from "../../src/utils/storage.js";
import type { FileTokens } from "../../src/utils/frontmatter.js";

export interface SyntheticFile {
  path: string;
  /** Plaintext content — only READ during the cold-tail backfill (extractTokens). */
  content: string;
  /** The retrieval column. null = not yet backfilled (the migration cold tail). */
  tokens: FileTokens | null;
}

function tok(
  frontmatter: string[],
  body: string[],
  identifiers: string[] = [],
): FileTokens {
  return { frontmatter, body, identifiers };
}

export interface SyntheticCorpusOptions {
  /** Total file count (e.g. 5_000, 15_000). */
  n: number;
  /** Path of the planted needle (defaults to the very last row by sort order). */
  targetPath?: string;
  /** Tokens for the needle. Picked so a unique body token retrieves ONLY it. */
  targetTokens?: FileTokens;
  /** Fraction [0,1] of files whose tokens column is null (the backfill cold tail). */
  nullFraction?: number;
}

export const NEEDLE_BODY_TOKEN = "zzzuniqueneedletoken";

/**
 * Build N synthetic files sorted by path. Filenames are zero-padded so lexical
 * order == numeric order (matters: the real reader pages by .order("path") ASC,
 * so a needle at "the 5000th file" must actually sort 5000th). The needle gets a
 * unique body token; everyone else gets bland filler so the needle is the ONLY
 * hit for NEEDLE_BODY_TOKEN.
 */
export function makeSyntheticCorpus(
  opts: SyntheticCorpusOptions,
): SyntheticFile[] {
  const { n, nullFraction = 0 } = opts;
  const width = String(n).length;
  const files: SyntheticFile[] = [];
  for (let i = 0; i < n; i++) {
    const idx = String(i).padStart(width, "0");
    const path = `daily/2026-06/filler-${idx}.md`;
    const isNull = nullFraction > 0 && i % Math.round(1 / nullFraction) === 0;
    files.push({
      path,
      content: `---\ntitle: Filler ${idx}\n---\n# Filler ${idx}\n\nRoutine filler body number ${idx}.`,
      tokens: isNull
        ? null
        : tok(["filler", idx], ["routine", "filler", "body", idx]),
    });
  }

  // Plant the needle. Default path sorts AFTER all filler (zzz prefix) so it lands
  // at the tail — only reachable if the uncapped reader paged the whole vault.
  const targetPath = opts.targetPath ?? `zzz-school/is-7011/needle-row-${n}.md`;
  const targetTokens =
    opts.targetTokens ?? tok([], [NEEDLE_BODY_TOKEN], ["7011"]);
  files.push({
    path: targetPath,
    content: `---\ntitle: Needle\n---\n# Needle\n\n${NEEDLE_BODY_TOKEN} 7011`,
    tokens: targetTokens,
  });

  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export interface StoreCounters {
  /** readFile call count — the LOAD signal a double-backfill inflates. */
  reads: number;
  /** Distinct paths actually written by batchUpdateTokens (idempotent null-fill). */
  writes: number;
}

/**
 * A mutable, ordered file store that reproduces the Supabase backend's
 * pagination + null-fill semantics. Multiple StorageBackend "instances" can be
 * built over ONE store (makeBackend) — modeling cache eviction: each fresh
 * backend object is a fresh WeakSet/WeakMap identity, so the per-instance
 * in-flight guard + retrieval cache do NOT carry across instances.
 */
export class SharedVaultStore {
  private rows: SyntheticFile[];
  readonly counters: StoreCounters = { reads: 0, writes: 0 };

  constructor(files: SyntheticFile[]) {
    // Keep the canonical sorted order the reader pages over.
    this.rows = [...files].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Count of rows whose tokens column is still null (the backfill target set). */
  nullCount(): number {
    return this.rows.filter((r) => r.tokens === null).length;
  }

  snapshotTokens(path: string): FileTokens | null | undefined {
    return this.rows.find((r) => r.path === path)?.tokens;
  }

  size(): number {
    return this.rows.length;
  }

  // ── Mutation injectors (the (b) race) ──
  deletePath(path: string): void {
    this.rows = this.rows.filter((r) => r.path !== path);
  }

  insertFile(file: SyntheticFile): void {
    this.rows.push(file);
    this.rows.sort((a, b) => a.path.localeCompare(b.path));
  }

  // ── Backend primitives (mirror supabase-mirror.ts) ──

  async readFile(path: string): Promise<string> {
    this.counters.reads += 1;
    const row = this.rows.find((r) => r.path === path);
    if (!row) throw new Error(`not found: ${path}`);
    return row.content;
  }

  /**
   * Faithful copy of SupabaseMirror.listFileTokensMeta: PAGE=1000, page over the
   * LIVE sorted rows with .range()-equivalent slicing, break on a short page.
   * `onPage(pageIndex)` fires AFTER each page is read — the seam where a test
   * injects a concurrent delete/insert to drive the OFFSET race.
   */
  async listFileTokensMeta(
    onPage?: (pageIndex: number) => void,
    page = 1000,
  ): Promise<FileMeta[]> {
    const out: FileMeta[] = [];
    let pageIndex = 0;
    for (let from = 0; ; from += page) {
      // Re-read the live store each page — exactly what a fresh SELECT does.
      const slice = this.rows.slice(from, from + page);
      for (const r of slice) {
        out.push({ path: r.path, cardinality: null, tokens: r.tokens });
      }
      onPage?.(pageIndex);
      pageIndex += 1;
      if (slice.length < page) break;
    }
    return out;
  }

  /** Strict null-fill (the `.is(null)` write-guard). Never clobbers a populated row. */
  batchUpdateTokens(updates: Map<string, FileTokens>): void {
    for (const [path, tokens] of updates) {
      const row = this.rows.find((r) => r.path === path);
      if (row && row.tokens === null) {
        row.tokens = tokens;
        this.counters.writes += 1;
      }
    }
  }
}

export interface MakeBackendOptions {
  /** Injected after each pagination page — the (b) race seam. */
  onPage?: (pageIndex: number) => void;
  /** Pagination size. Defaults to 1000 (prod). Tests use a small page to make
   * the OFFSET race legible without 1000s of rows. */
  page?: number;
  /** Wrap readFile so a test can gate / observe individual reads (the (a) overlap). */
  onRead?: (path: string) => Promise<void> | void;
}

/**
 * Build a fresh StorageBackend over a shared store. Each call returns a NEW
 * object reference — a distinct WeakMap/WeakSet identity in retrieval-index.ts,
 * which is precisely what a 5-min LRU eviction produces: the next request gets a
 * brand-new instance whose in-flight guard + index cache start empty.
 */
export function makeBackend(
  store: SharedVaultStore,
  opts: MakeBackendOptions = {},
): StorageBackend {
  return {
    readFile: async (p: string) => {
      await opts.onRead?.(p);
      return store.readFile(p);
    },
    listFileTokensMeta: async () =>
      store.listFileTokensMeta(opts.onPage, opts.page ?? 1000),
    // The CAPPED fallback — mirrors prod: SupabaseMirror.listFilesMeta hard-caps
    // at 1000 rows (supabase-mirror.ts:554). Modeling the cap here is what makes
    // the oversized-vault eval meaningful: if getRetrievalIndex ever regressed to
    // the fallback, a needle past row 1000 would VANISH and the test would catch it.
    listFilesMeta: async () =>
      (await store.listFileTokensMeta(undefined, opts.page ?? 1000)).slice(
        0,
        1000,
      ),
    batchUpdateTokens: async (updates: Map<string, FileTokens>) =>
      store.batchUpdateTokens(updates),
  } as unknown as StorageBackend;
}
