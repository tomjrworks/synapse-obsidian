import fs from "node:fs";
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
}

/**
 * Local filesystem backend. Reads/writes files directly.
 * Used for Claude Desktop and Claude Code (stdio transport).
 */
export class LocalBackend implements StorageBackend {
  constructor(private vaultPath: string) {}

  async readFile(filePath: string): Promise<string> {
    const fullPath = this.resolveSafe(filePath);
    return fs.readFileSync(fullPath, "utf-8");
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const fullPath = this.resolveSafe(filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf-8");
  }

  async listFiles(subPath?: string, recursive = true): Promise<string[]> {
    const dir = subPath ? this.resolveSafe(subPath) : this.vaultPath;

    if (!fs.existsSync(dir)) return [];

    return this.listRecursive(dir, recursive);
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      const fullPath = this.resolveSafe(filePath);
      return fs.existsSync(fullPath);
    } catch {
      return false;
    }
  }

  async mkdir(dirPath: string): Promise<void> {
    const fullPath = this.resolveSafe(dirPath);
    fs.mkdirSync(fullPath, { recursive: true });
  }

  async delete(filePath: string): Promise<void> {
    const fullPath = this.resolveSafe(filePath);
    fs.unlinkSync(fullPath);
  }

  async move(oldPath: string, newPath: string): Promise<void> {
    const oldFull = this.resolveSafe(oldPath);
    const newFull = this.resolveSafe(newPath);
    fs.mkdirSync(path.dirname(newFull), { recursive: true });
    fs.renameSync(oldFull, newFull);
  }

  async stat(filePath: string): Promise<FileStat> {
    const fullPath = this.resolveSafe(filePath);
    const s = fs.statSync(fullPath);
    return { size: s.size, modifiedAt: s.mtime };
  }

  async recentFiles(n: number): Promise<string[]> {
    const all = await this.listFiles(undefined, true);
    const withMtime = all.map((relative) => ({
      relative,
      mtimeMs: fs.statSync(path.join(this.vaultPath, relative)).mtimeMs,
    }));
    withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return withMtime.slice(0, n).map((x) => x.relative);
  }

  private listRecursive(dir: string, recursive: boolean): string[] {
    const results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;

      const entryPath = path.join(dir, entry.name);
      const relative = path.relative(this.vaultPath, entryPath);

      if (entry.isDirectory() && recursive) {
        results.push(...this.listRecursive(entryPath, true));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(relative);
      }
    }

    return results;
  }

  private resolveSafe(filePath: string): string {
    const resolved = path.resolve(this.vaultPath, filePath);
    if (!resolved.startsWith(this.vaultPath)) {
      throw new Error(
        `Path traversal detected: ${filePath} resolves outside vault`,
      );
    }
    return resolved;
  }
}
