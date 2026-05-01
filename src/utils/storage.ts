import { promises as fsp, constants as fsConstants } from "node:fs";
import path from "node:path";

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
}

export interface PullCursor {
  modifiedAt: string;
  id: string;
}

export interface ListChangedResult {
  files: VaultFileChange[];
  next: PullCursor | null;
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
