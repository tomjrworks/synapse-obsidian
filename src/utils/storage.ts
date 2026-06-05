import { promises as fsp, constants as fsConstants } from "node:fs";
import path from "node:path";
import {
  extractCardinality,
  extractTokens,
  type Cardinality,
  type FileTokens,
} from "./frontmatter.js";
import { extractOutlinks, type FileOutlinks } from "./outlinks.js";

/**
 * Abstract storage backend interface.
 * Implementations: LocalBackend (filesystem),
 * SupabaseEncryptedMirrorBackend (Stage 1 T4).
 */
export interface FileStat {
  size: number;
  modifiedAt: Date;
}

// Typed errors so MCP tool layer can map cleanly: NotFoundError → not_found,
// ConflictError → conflict, anything else → internal.
export class NotFoundError extends Error {
  constructor(filePath: string) {
    super(`Not found: ${filePath}`);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

// T11.4 pull-engine wire types. listChanged powers GET /api/sync/pull —
// helper polls the server for vault changes since a (modifiedAt, id) tuple
// cursor and applies them to the local folder.
export interface VaultFileChange {
  path: string;
  size: number;
  modifiedAt: string; // ISO8601 — opaque cursor token, server-defined
  id: string; // UUID — tiebreaker for tuple cursor
  deleted: boolean;
  content?: string; // plaintext for non-deleted rows (D1.a inline content)
  // S99 PR #2: row exists but blob is missing AND modified_at is within
  // MISSING_BLOB_GRACE_MS — the upload is plausibly still in flight from a
  // metadata-first write that crashed mid-flow. Helper MUST skip locally
  // (do not write, do not delete); the server's grace-window-then-delete
  // semantic plus cursor halt-on-pending (see listChanged) recovers either
  // by serving content on the next pull or by emitting deleted: true once
  // the grace window expires.
  pending?: boolean;
}

export interface PullCursor {
  modifiedAt: string;
  id: string;
}

export interface ListChangedResult {
  files: VaultFileChange[];
  next: PullCursor | null;
  pendingCount: number; // rows remaining after this page; 0 = caught up
}

// Lightweight per-file metadata for index builds — avoids the per-file
// readFile fanout that dominates loadIndexData on Supabase-mirrored vaults.
// cardinality is null when the backend hasn't yet extracted it (one-time
// backfill case) or extraction failed.
export interface FileMeta {
  path: string;
  cardinality: Cardinality | null;
  // Pass 3: per-file content tokens for the retrieval index. null when the
  // backend hasn't extracted them yet (one-time backfill, exactly like
  // cardinality). Always null on backends/rows predating the column.
  tokens?: FileTokens | null;
  // Pass 4b: per-file [[wikilink]] outlink keys for garden_backlinks. null when
  // the backend hasn't extracted them yet (one-time backfill, exactly like
  // tokens). Always null on backends/rows predating the extracted_outlinks
  // column. Only populated by listFileOutlinksMeta (the backlinks read path).
  outlinks?: FileOutlinks | null;
}

export interface StorageBackend {
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  listFiles(subPath?: string, recursive?: boolean): Promise<string[]>;
  exists(filePath: string): Promise<boolean>;
  mkdir(dirPath: string): Promise<void>;
  delete(filePath: string): Promise<void>;
  move(oldPath: string, newPath: string): Promise<void>;
  stat(filePath: string): Promise<FileStat>;
  recentFiles(n: number): Promise<string[]>;
  listChanged(
    cursor: PullCursor | null,
    limit: number,
  ): Promise<ListChangedResult>;
  getCursorHead(): Promise<{ modifiedAt: string; id: string } | null>;
  getPendingCount(cursor: PullCursor | null): Promise<number>;
  listFilesMeta(subPath?: string): Promise<FileMeta[]>;
  // Pass 3: per-file tokens for the V2 retrieval index, UNCAPPED. listFilesMeta
  // caps at 1000 rows because it feeds index.md's map (which WANTS the cap +
  // "Showing first 1000" notice). Retrieval must not inherit that cap — on a
  // vault >1000 files a ranked search has to see every file, or notes past the
  // 1000th become silently unreachable. This reads the same column, paginated,
  // with no cap. Optional: callers fall back to listFilesMeta when a backend (or
  // a test mock) doesn't implement it.
  listFileTokensMeta?(subPath?: string): Promise<FileMeta[]>;
  batchUpdateCardinalities(updates: Map<string, Cardinality>): Promise<void>;
  // Pass 3: persist backfilled per-file tokens. Strict null-fill on the
  // Supabase backend (never clobbers a fresh writeFile value); no-op on Local.
  batchUpdateTokens(updates: Map<string, FileTokens>): Promise<void>;
  // Pass 4b: per-file outlink keys for garden_backlinks, UNCAPPED + paginated
  // (same shape + rationale as listFileTokensMeta — a set-membership backlinks
  // answer must see every file or it silently misses real inbound links).
  // Reads the stored extracted_outlinks column; NO blob decrypt. Optional:
  // callers feature-detect and fall back gracefully on backends/mocks without
  // it (the tool returns honest-empty rather than throwing).
  listFileOutlinksMeta?(subPath?: string): Promise<FileMeta[]>;
  // Pass 4b: persist backfilled per-file outlinks. Strict null-fill on the
  // Supabase backend (never clobbers a fresh writeFile value); no-op on Local.
  // Optional for the same feature-detect reason as listFileOutlinksMeta.
  batchUpdateOutlinks?(updates: Map<string, FileOutlinks>): Promise<void>;
}

/**
 * Local filesystem backend. Reads/writes files directly.
 * Used for Claude Desktop and Claude Code (stdio transport) and as the
 * personal-MCP backend in HTTP mode (T6.1: /mcp routes through the
 * encrypted mirror; LocalBackend is reserved for /api/first-wow).
 *
 * T5: async I/O throughout (no event-loop blocking under concurrent
 * requests) and typed NotFoundError / ConflictError matching the
 * SupabaseEncryptedMirrorBackend semantics so the MCP tool layer can
 * map errors uniformly across backends.
 */
export class LocalBackend implements StorageBackend {
  constructor(private vaultPath: string) {}

  async readFile(filePath: string): Promise<string> {
    const fullPath = this.resolveSafe(filePath);
    try {
      return await fsp.readFile(fullPath, "utf-8");
    } catch (err: any) {
      if (err?.code === "ENOENT") throw new NotFoundError(filePath);
      throw err;
    }
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const fullPath = this.resolveSafe(filePath);
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    await fsp.writeFile(fullPath, content, "utf-8");
  }

  async listFiles(subPath?: string, recursive = true): Promise<string[]> {
    const dir = subPath ? this.resolveSafe(subPath) : this.vaultPath;
    try {
      return await this.listRecursive(dir, recursive);
    } catch (err: any) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
  }

  async exists(filePath: string): Promise<boolean> {
    if (typeof filePath !== "string" || !filePath.trim()) return false;
    let fullPath: string;
    try {
      fullPath = this.resolveSafe(filePath);
    } catch {
      return false;
    }
    try {
      await fsp.access(fullPath, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(dirPath: string): Promise<void> {
    const fullPath = this.resolveSafe(dirPath);
    await fsp.mkdir(fullPath, { recursive: true });
  }

  async delete(filePath: string): Promise<void> {
    const fullPath = this.resolveSafe(filePath);
    try {
      await fsp.unlink(fullPath);
    } catch (err: any) {
      if (err?.code === "ENOENT") throw new NotFoundError(filePath);
      throw err;
    }
  }

  async move(oldPath: string, newPath: string): Promise<void> {
    if (oldPath === newPath) return;
    const oldFull = this.resolveSafe(oldPath);
    const newFull = this.resolveSafe(newPath);

    // Mirror semantics: collision is a typed ConflictError, not a silent
    // overwrite. POSIX `rename` overwrites by default; pre-check with
    // access(). Race window between check and rename is acceptable for
    // single-process LocalBackend (Stage 1 scope).
    try {
      await fsp.access(newFull, fsConstants.F_OK);
      throw new ConflictError(`Target already exists: ${newPath}`);
    } catch (err: any) {
      if (err instanceof ConflictError) throw err;
      if (err?.code !== "ENOENT") throw err;
    }

    await fsp.mkdir(path.dirname(newFull), { recursive: true });
    try {
      await fsp.rename(oldFull, newFull);
    } catch (err: any) {
      if (err?.code === "ENOENT") throw new NotFoundError(oldPath);
      throw err;
    }
  }

  async stat(filePath: string): Promise<FileStat> {
    const fullPath = this.resolveSafe(filePath);
    try {
      const s = await fsp.stat(fullPath);
      return { size: s.size, modifiedAt: s.mtime };
    } catch (err: any) {
      if (err?.code === "ENOENT") throw new NotFoundError(filePath);
      throw err;
    }
  }

  async recentFiles(n: number): Promise<string[]> {
    if (n <= 0) return [];
    const all = await this.listFiles(undefined, true);
    const withMtime = await Promise.all(
      all.map(async (relative) => ({
        relative,
        mtimeMs: (await fsp.stat(path.join(this.vaultPath, relative))).mtimeMs,
      })),
    );
    withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return withMtime.slice(0, n).map((x) => x.relative);
  }

  async listChanged(
    _cursor: PullCursor | null,
    _limit: number,
  ): Promise<ListChangedResult> {
    // LocalBackend is reserved for /api/first-wow + stdio Claude-Desktop
    // path. /api/sync/pull only routes through SupabaseEncryptedMirrorBackend.
    // Throw rather than no-op so a misrouted request fails loudly.
    throw new Error("listChanged is not supported by LocalBackend");
  }

  async getCursorHead(): Promise<{ modifiedAt: string; id: string } | null> {
    throw new Error("getCursorHead is not supported by LocalBackend");
  }

  async getPendingCount(_cursor: PullCursor | null): Promise<number> {
    throw new Error("getPendingCount is not supported by LocalBackend");
  }

  async listFilesMeta(subPath?: string): Promise<FileMeta[]> {
    const files = await this.listFiles(subPath, true);
    const results: FileMeta[] = [];
    for (const filePath of files) {
      try {
        const content = await this.readFile(filePath);
        results.push({
          path: filePath,
          cardinality: extractCardinality(content),
          // Local reads are fast unencrypted disk reads — build tokens inline
          // (no column). The assembly + scoring logic is backend-identical.
          tokens: extractTokens(content),
        });
      } catch {
        results.push({ path: filePath, cardinality: null, tokens: null });
      }
    }
    return results;
  }

  async batchUpdateCardinalities(
    _updates: Map<string, Cardinality>,
  ): Promise<void> {
    // No-op: LocalBackend reads fresh from disk on every listFilesMeta call,
    // so there's nowhere to "store" extracted cardinalities. Only the
    // Supabase backend persists this column.
  }

  async batchUpdateTokens(_updates: Map<string, FileTokens>): Promise<void> {
    // No-op: same reason as batchUpdateCardinalities — Local rebuilds tokens
    // from disk every listFilesMeta call. Only Supabase persists the column.
  }

  async batchUpdateOutlinks(
    _updates: Map<string, FileOutlinks>,
  ): Promise<void> {
    // No-op: same reason as batchUpdateTokens — Local re-extracts outlinks from
    // disk on every listFileOutlinksMeta call. Only Supabase persists the column.
  }

  async listFileOutlinksMeta(subPath?: string): Promise<FileMeta[]> {
    // LocalBackend reads fast unencrypted disk, so the "stored column" is just
    // an inline re-extraction over the live tree — no 1000-row cap to inherit
    // (listFiles walks the whole tree). Backend-identical to the Supabase
    // column read from garden_backlinks' perspective.
    const files = await this.listFiles(subPath, true);
    const results: FileMeta[] = [];
    for (const filePath of files) {
      try {
        results.push({
          path: filePath,
          cardinality: null,
          outlinks: extractOutlinks(await this.readFile(filePath)),
        });
      } catch {
        results.push({ path: filePath, cardinality: null, outlinks: null });
      }
    }
    return results;
  }

  async listFileTokensMeta(subPath?: string): Promise<FileMeta[]> {
    // LocalBackend has no 1000-row cap (listFilesMeta walks the whole disk
    // tree), so the uncapped reader is just the same call. Tokens are built
    // inline from fast unencrypted disk reads.
    return this.listFilesMeta(subPath);
  }

  private async listRecursive(
    dir: string,
    recursive: boolean,
  ): Promise<string[]> {
    const results: string[] = [];
    const entries = await fsp.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;

      const entryPath = path.join(dir, entry.name);
      const relative = path.relative(this.vaultPath, entryPath);

      if (entry.isDirectory() && recursive) {
        results.push(...(await this.listRecursive(entryPath, true)));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(relative);
      }
    }

    return results;
  }

  private resolveSafe(filePath: string): string {
    // H9 (04-30): control chars bypass filesystem checks on some kernels.
    if (/[\x00-\x1f\x7f]/.test(filePath)) {
      throw new Error(`Invalid path: control characters not allowed`);
    }
    const resolved = path.resolve(this.vaultPath, filePath);
    const rel = path.relative(this.vaultPath, resolved);
    if (
      rel === ".." ||
      rel.startsWith(".." + path.sep) ||
      path.isAbsolute(rel)
    ) {
      throw new Error(
        `Path traversal detected: ${filePath} resolves outside vault`,
      );
    }
    return resolved;
  }
}
