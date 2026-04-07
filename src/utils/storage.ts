import fs from "node:fs";
import path from "node:path";

/**
 * Abstract storage backend interface.
 * Implementations: LocalBackend (filesystem), GoogleDriveBackend, DropboxBackend.
 */
export interface StorageBackend {
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  listFiles(subPath?: string, recursive?: boolean): Promise<string[]>;
  exists(filePath: string): Promise<boolean>;
  mkdir(dirPath: string): Promise<void>;
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
