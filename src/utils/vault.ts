import path from "node:path";
import matter from "gray-matter";
import type { StorageBackend } from "./storage.js";
import { tokenize, tokenizeQuery } from "./tokenize.js";

/**
 * Read a file from the vault, returning its content.
 */
export async function readVaultFile(
  backend: StorageBackend,
  filePath: string,
): Promise<string> {
  return backend.readFile(filePath);
}

/**
 * Write content to a file in the vault, creating directories as needed.
 */
export async function writeVaultFile(
  backend: StorageBackend,
  filePath: string,
  content: string,
): Promise<void> {
  return backend.writeFile(filePath, content);
}

/**
 * List markdown files in a directory (or whole vault).
 */
export async function listVaultFiles(
  backend: StorageBackend,
  subPath?: string,
  recursive = true,
): Promise<string[]> {
  return backend.listFiles(subPath, recursive);
}

export interface ScanVaultBodiesOptions {
  /** Restrict the scan to a subfolder (passed through to listFiles). */
  subPath?: string;
  /** Stop collecting once this many matches are found. Default 20. */
  maxResults?: number;
  /**
   * Hard cap on files actually read. `undefined` = legacy unbounded (the old
   * searchVault behavior). This is the load-bearing knob: it *stops* the scan
   * instead of racing a timer, so a no-match query over a 1411-file encrypted
   * vault reads at most this many files rather than the whole workspace.
   */
  maxFilesScanned?: number;
  /**
   * Secondary wall-clock guard, checked IN-LOOP (not via Promise.race) so the
   * loop actually breaks — no orphaned background scan. Default 15000ms.
   */
  budgetMs?: number;
  /** Files read per chunked Promise.all batch. Default 10. */
  concurrency?: number;
  /**
   * Files to scan first (e.g. index.md hints from parseForageHints) so the
   * most-relevant notes are covered before the cap bites. Matched by full path
   * or basename, mirroring garden_forage's prior inline ordering.
   */
  priorityHints?: string[];
  /**
   * Pass 3 (TAPROOT_RETRIEVAL_V2): match per-TOKEN instead of testing the whole
   * query as one substring per line (RC #5). A line matches if it shares ANY
   * query token (word-boundary, via the shared tokenizer), so a multi-word query
   * like `stripe webhook errors` matches a line containing just `errors`. Default
   * false = V1 whole-query substring (byte-for-byte rollback). Bounding/budget
   * semantics are unchanged either way.
   */
  tokenized?: boolean;
}

export interface ScanVaultBodiesResult {
  results: SearchResult[];
  /** Files actually read (== backend.readFile calls). Never exceeds the cap. */
  scannedCount: number;
  /** Hit maxFilesScanned. */
  capped: boolean;
  /** Hit budgetMs. */
  timedOut: boolean;
}

/**
 * Canonical bounded body scanner. Replaces the naive serial `searchVault`
 * whose only early-exit (`results.length >= maxResults`) never fired on a
 * no-match query, so it read + decrypted the entire vault one file at a time.
 *
 * This scans concurrently and breaks the loop on ANY of: enough matches
 * collected, the file cap reached, or the wall-clock budget exceeded. Because
 * the loop itself stops, there is no losing-promise background churn (the
 * problem with the `withTimeout` = `Promise.race` approach).
 *
 * Env-free by design — callers resolve `maxFilesScanned` via `resolveScanCap()`
 * so this primitive stays deterministic under test.
 */
export async function scanVaultBodies(
  backend: StorageBackend,
  query: string,
  options: ScanVaultBodiesOptions = {},
): Promise<ScanVaultBodiesResult> {
  const {
    subPath,
    maxResults = 20,
    maxFilesScanned,
    budgetMs = 15000,
    concurrency = 10,
    priorityHints,
    tokenized = false,
  } = options;

  const start = Date.now();
  const lowerQuery = query.toLowerCase();
  // Per-token (V2) vs whole-query-substring (V1) line matcher. Resolved once.
  const queryTokenSet = tokenized ? new Set(tokenizeQuery(query)) : null;
  const lineMatches = (line: string): boolean => {
    if (queryTokenSet === null) return line.toLowerCase().includes(lowerQuery);
    for (const t of tokenize(line)) if (queryTokenSet.has(t)) return true;
    return false;
  };
  const results: SearchResult[] = [];
  let scannedCount = 0;
  let capped = false;
  let timedOut = false;

  // Race the listing against the budget too: a hung vault_files SELECT must not
  // wedge the whole tool. This races ONE call (not the 1411-file read loop), so
  // it does not reintroduce the per-file background churn the in-loop cap fixes.
  const listPromise = listVaultFiles(backend, subPath);
  listPromise.catch(() => {}); // no unhandled rejection if it settles post-budget
  const listed = await Promise.race([
    listPromise.then((f) => ({ files: f as string[] | undefined })),
    new Promise<{ files: string[] | undefined }>((res) =>
      setTimeout(() => res({ files: undefined }), budgetMs),
    ),
  ]);
  if (!listed.files) {
    return { results, scannedCount, capped, timedOut: true };
  }
  let files = listed.files;

  if (priorityHints && priorityHints.length > 0) {
    const hintBasenames = new Set(priorityHints.map((h) => path.basename(h)));
    const isPriority = (f: string) =>
      priorityHints.includes(f) || hintBasenames.has(path.basename(f));
    files = [
      ...files.filter(isPriority),
      ...files.filter((f) => !isPriority(f)),
    ];
  }

  for (let i = 0; i < files.length; ) {
    if (results.length >= maxResults) break;
    if (maxFilesScanned !== undefined && scannedCount >= maxFilesScanned) {
      capped = true;
      break;
    }
    if (Date.now() - start > budgetMs) {
      timedOut = true;
      break;
    }

    // Size the chunk so we never read past the cap (no chunk-boundary overshoot).
    let size = concurrency;
    if (maxFilesScanned !== undefined) {
      size = Math.min(size, maxFilesScanned - scannedCount);
    }
    size = Math.min(size, files.length - i);
    const chunk = files.slice(i, i + size);
    i += size;

    const chunkHits = await Promise.all(
      chunk.map(async (file): Promise<SearchResult | null> => {
        try {
          const content = await readVaultFile(backend, file);
          const lines = content.split("\n");
          const matches: SearchMatch[] = [];
          for (let j = 0; j < lines.length; j++) {
            if (lineMatches(lines[j])) {
              matches.push({ line: j + 1, text: lines[j].trim() });
            }
          }
          if (matches.length === 0) return null;
          const fm = parseFrontmatter(content);
          return {
            file,
            title:
              (fm.title as string | undefined) || path.basename(file, ".md"),
            dateModified:
              normalizeFrontmatterDate(fm.date_modified) ?? undefined,
            matches,
          };
        } catch {
          return null;
        }
      }),
    );
    scannedCount += chunk.length;
    for (const hit of chunkHits) {
      if (hit !== null && results.length < maxResults) results.push(hit);
    }
  }

  return { results, scannedCount, capped, timedOut };
}

/**
 * Resolve the body-scan file cap from the SCAN_FILE_CAP env var.
 * Cap is ON by default (unset => 300). `SCAN_FILE_CAP=0` is the explicit
 * legacy escape hatch (unbounded). Mirrors the MISSING_BLOB_LEGACY_BEHAVIOR
 * precedent: new behavior is the default, you opt INTO legacy.
 */
export function resolveScanCap(): number | undefined {
  const raw = process.env.SCAN_FILE_CAP;
  if (raw === undefined) return 300;
  const trimmed = raw.trim();
  if (trimmed === "0") return undefined; // legacy unbounded
  if (trimmed === "") return 300;
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) && n > 0 ? n : 300;
}

/**
 * Parse YAML frontmatter from markdown content.
 */
export function parseFrontmatter(content: string): Record<string, any> {
  try {
    const { data } = matter(content);
    return data;
  } catch {
    return {};
  }
}

/**
 * Normalize a frontmatter date value to `YYYY-MM-DD` for display.
 * Accepts string (iso, date-only, or anything Date-parseable), Date,
 * or number (epoch ms). Returns null for missing/malformed values.
 * Mirrors the coercion shape used by `extractCardinality` in
 * `src/utils/frontmatter.ts` for the `created` field.
 */
export function normalizeFrontmatterDate(raw: unknown): string | null {
  if (raw == null) return null;
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return null;
    return raw.toISOString().split("T")[0];
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    // Accept already-date-shaped strings as-is (YYYY-MM-DD or full iso).
    const datePart = trimmed.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return datePart;
    const d = new Date(trimmed);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split("T")[0];
  }
  if (typeof raw === "number") {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split("T")[0];
  }
  return null;
}

/**
 * Get vault statistics.
 */
export async function getVaultStats(
  backend: StorageBackend,
): Promise<VaultStats> {
  const allFiles = await listVaultFiles(backend);
  const folders = new Set<string>();

  for (const f of allFiles) {
    const dir = path.dirname(f);
    if (dir !== ".") folders.add(dir);
  }

  const hasSources = await backend.exists("sources");
  const hasNotes = await backend.exists("notes");
  const hasClaudeMd = await backend.exists("CLAUDE.md");
  const hasIndex = await backend.exists("index.md");

  return {
    totalFiles: allFiles.length,
    totalFolders: folders.size,
    topFolders: [...folders].slice(0, 10),
    knowledgeBase: {
      initialized: hasSources && hasClaudeMd,
      hasSources,
      hasNotes,
      hasClaudeMd,
      hasIndex,
    },
  };
}

export interface SearchMatch {
  line: number;
  text: string;
}

export interface SearchResult {
  file: string;
  title: string;
  /** Normalized `date_modified` from frontmatter, when present. */
  dateModified?: string;
  matches: SearchMatch[];
}

export interface VaultStats {
  totalFiles: number;
  totalFolders: number;
  topFolders: string[];
  knowledgeBase: {
    initialized: boolean;
    hasSources: boolean;
    hasNotes: boolean;
    hasClaudeMd: boolean;
    hasIndex: boolean;
  };
}
