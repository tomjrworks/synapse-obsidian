/**
 * Folder-scan + summary derivation for setup-scan / persona-render.
 *
 * Replaces trait-based CLAUDE.md scaffolding: instead of asking the user to
 * declare workflow up front, we observe their actual vault and derive a
 * folder list + one-liner per folder. Rule-based, no LLM (per plan L1).
 *
 * Fallback chain for each folder's summary:
 *   1. Frontmatter `summary:` field on most-recently-modified note.
 *   2. First H1 heading on that note.
 *   3. First non-empty content line, truncated at 100 chars.
 *   4. Folder name as-is.
 */
import type { StorageBackend } from "./storage.js";
import { listVaultFiles } from "./vault.js";

export interface FolderSummary {
  name: string;
  summary: string;
}

const HIDDEN_PREFIXES = [".", "_"];
const HIDDEN_NAMES = new Set([
  ".obsidian",
  ".trash",
  ".git",
  ".taproot",
  ".synapse",
  "node_modules",
]);

function isHidden(folder: string): boolean {
  if (HIDDEN_NAMES.has(folder)) return true;
  return HIDDEN_PREFIXES.some((p) => folder.startsWith(p));
}

interface FileMeta {
  path: string;
  mtime: number;
}

interface FolderBucket {
  notes: FileMeta[];
}

async function readMtime(
  backend: StorageBackend,
  path: string,
): Promise<number> {
  try {
    const s = await backend.stat(path);
    const m = s.modifiedAt;
    return m instanceof Date ? m.getTime() : Number(m) || 0;
  } catch {
    return 0;
  }
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const SUMMARY_LINE_RE = /^summary:\s*(.+?)\s*$/m;
const H1_RE = /^#\s+(.+?)\s*$/m;

function extractSummary(content: string): string | null {
  const fm = content.match(FRONTMATTER_RE);
  if (fm) {
    const body = fm[1];
    const m = body.match(SUMMARY_LINE_RE);
    if (m) {
      let s = m[1].trim();
      if (
        (s.startsWith('"') && s.endsWith('"')) ||
        (s.startsWith("'") && s.endsWith("'"))
      ) {
        s = s.slice(1, -1);
      }
      if (s) return s;
    }
  }
  return null;
}

function extractH1(content: string): string | null {
  const body = content.replace(FRONTMATTER_RE, "");
  const m = body.match(H1_RE);
  if (m && m[1].trim()) return m[1].trim();
  return null;
}

function extractFirstLine(content: string): string | null {
  const body = content.replace(FRONTMATTER_RE, "");
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    const truncated = line.length > 100 ? line.slice(0, 97) + "..." : line;
    return truncated;
  }
  return null;
}

function deriveSummary(folderName: string, content: string): string {
  return (
    extractSummary(content) ??
    extractH1(content) ??
    extractFirstLine(content) ??
    `${folderName}/`
  );
}

/**
 * Scan top-level vault folders and produce one-line summaries.
 *
 * Strategy:
 *   - List all vault files via the backend.
 *   - Bucket by top-level folder (ignore hidden).
 *   - For each bucket, pick the most-recently-modified .md note.
 *   - Apply the L1 fallback chain to derive a summary.
 *   - Return alphabetical-sorted list.
 *
 * Returns [] if the vault has no top-level folders.
 */
export async function scanFolders(
  backend: StorageBackend,
): Promise<FolderSummary[]> {
  const files = await listVaultFiles(backend);
  const buckets = new Map<string, FolderBucket>();

  for (const f of files) {
    const slash = f.indexOf("/");
    if (slash <= 0) continue;
    const top = f.slice(0, slash);
    if (isHidden(top)) continue;
    if (!f.toLowerCase().endsWith(".md")) continue;
    let bucket = buckets.get(top);
    if (!bucket) {
      bucket = { notes: [] };
      buckets.set(top, bucket);
    }
    bucket.notes.push({ path: f, mtime: 0 });
  }

  const folders = [...buckets.keys()].sort();
  const out: FolderSummary[] = [];

  for (const name of folders) {
    const bucket = buckets.get(name)!;
    for (const note of bucket.notes) {
      note.mtime = await readMtime(backend, note.path);
    }
    bucket.notes.sort((a, b) => b.mtime - a.mtime);

    let summary = `${name}/`;
    for (const note of bucket.notes) {
      try {
        const content = await backend.readFile(note.path);
        const derived = deriveSummary(name, content);
        if (derived && derived !== `${name}/`) {
          summary = derived;
          break;
        }
        summary = derived;
      } catch {
        continue;
      }
    }
    out.push({ name, summary });
  }

  return out;
}

export const _internal = {
  extractSummary,
  extractH1,
  extractFirstLine,
  deriveSummary,
  isHidden,
};
