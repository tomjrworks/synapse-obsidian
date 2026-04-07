import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

/**
 * Read a file from the vault, returning its content.
 */
export function readVaultFile(vaultPath: string, filePath: string): string {
  const fullPath = resolveSafe(vaultPath, filePath);
  return fs.readFileSync(fullPath, "utf-8");
}

/**
 * Write content to a file in the vault, creating directories as needed.
 */
export function writeVaultFile(
  vaultPath: string,
  filePath: string,
  content: string,
): void {
  const fullPath = resolveSafe(vaultPath, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

/**
 * List markdown files in a directory (or whole vault).
 */
export function listVaultFiles(
  vaultPath: string,
  subPath?: string,
  recursive = true,
): string[] {
  const dir = subPath ? resolveSafe(vaultPath, subPath) : vaultPath;

  if (!fs.existsSync(dir)) return [];

  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    // Skip hidden dirs like .obsidian, .git, .trash
    if (entry.name.startsWith(".")) continue;

    const entryPath = path.join(dir, entry.name);
    const relative = path.relative(vaultPath, entryPath);

    if (entry.isDirectory() && recursive) {
      results.push(...listVaultFiles(vaultPath, relative, true));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(relative);
    }
  }

  return results;
}

/**
 * Search vault files for a text pattern (case-insensitive).
 * Returns matching files with line numbers and context.
 */
export function searchVault(
  vaultPath: string,
  query: string,
  options: { subPath?: string; maxResults?: number } = {},
): SearchResult[] {
  const { subPath, maxResults = 20 } = options;
  const files = listVaultFiles(vaultPath, subPath);
  const results: SearchResult[] = [];
  const lowerQuery = query.toLowerCase();

  for (const file of files) {
    if (results.length >= maxResults) break;

    const content = readVaultFile(vaultPath, file);
    const lines = content.split("\n");
    const matches: SearchMatch[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(lowerQuery)) {
        matches.push({
          line: i + 1,
          text: lines[i].trim(),
        });
      }
    }

    if (matches.length > 0) {
      const fm = parseFrontmatter(content);
      results.push({
        file,
        title: fm.title || path.basename(file, ".md"),
        matches,
      });
    }
  }

  return results;
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
 * Get vault statistics.
 */
export function getVaultStats(vaultPath: string): VaultStats {
  const allFiles = listVaultFiles(vaultPath);
  const folders = new Set<string>();

  for (const f of allFiles) {
    const dir = path.dirname(f);
    if (dir !== ".") folders.add(dir);
  }

  // Check for knowledge base structure
  const hasRaw = fs.existsSync(path.join(vaultPath, "raw"));
  const hasWiki = fs.existsSync(path.join(vaultPath, "wiki"));
  const hasClaudeMd = fs.existsSync(path.join(vaultPath, "CLAUDE.md"));
  const hasIndex = fs.existsSync(path.join(vaultPath, "wiki", "index.md"));

  return {
    totalFiles: allFiles.length,
    totalFolders: folders.size,
    topFolders: [...folders].slice(0, 10),
    knowledgeBase: {
      initialized: hasRaw && hasWiki && hasClaudeMd,
      hasRaw,
      hasWiki,
      hasClaudeMd,
      hasIndex,
    },
  };
}

/**
 * Resolve a path safely within the vault (prevent directory traversal).
 */
function resolveSafe(vaultPath: string, filePath: string): string {
  const resolved = path.resolve(vaultPath, filePath);
  if (!resolved.startsWith(vaultPath)) {
    throw new Error(
      `Path traversal detected: ${filePath} resolves outside vault`,
    );
  }
  return resolved;
}

export interface SearchMatch {
  line: number;
  text: string;
}

export interface SearchResult {
  file: string;
  title: string;
  matches: SearchMatch[];
}

export interface VaultStats {
  totalFiles: number;
  totalFolders: number;
  topFolders: string[];
  knowledgeBase: {
    initialized: boolean;
    hasRaw: boolean;
    hasWiki: boolean;
    hasClaudeMd: boolean;
    hasIndex: boolean;
  };
}
