import path from "node:path";
import matter from "gray-matter";
import type { StorageBackend } from "./storage.js";

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

/**
 * Search vault files for a text pattern (case-insensitive).
 * Returns matching files with line numbers and context.
 */
export async function searchVault(
  backend: StorageBackend,
  query: string,
  options: { subPath?: string; maxResults?: number } = {},
): Promise<SearchResult[]> {
  const { subPath, maxResults = 20 } = options;
  const files = await listVaultFiles(backend, subPath);
  const results: SearchResult[] = [];
  const lowerQuery = query.toLowerCase();

  for (const file of files) {
    if (results.length >= maxResults) break;

    const content = await readVaultFile(backend, file);
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
