/**
 * Vault-level path-exclusion patterns parsed from CLAUDE.md.
 *
 * Why CLAUDE.md and not a .taprootignore dotfile: helper-mac drops every
 * hidden file from sync at WorkspaceWatcher.swift:145
 * (`if url.lastPathComponent.hasPrefix(".") { continue }`). Anything starting
 * with a dot never reaches Supabase Storage, so PRODUCT can't read it.
 *
 * Putting patterns in CLAUDE.md is fine because:
 *   - CLAUDE.md is always synced (regular .md file)
 *   - A user_owned CLAUDE.md is read-only from PRODUCT's POV (the three-state
 *     classifier protects it from clobber)
 *   - Patterns live next to the filing rules they relate to — single source
 *     of truth for vault-level configuration
 *
 * Format inside CLAUDE.md (HTML comment so it doesn't render in Obsidian):
 *
 *   <!-- TAPROOT-IGNORE
 *   # comments allowed (lines starting with #)
 *   projects/taproot/marketing/ig-outreach/leads/    ← trailing slash = directory
 *   research/big-corpus.md                            ← exact file path
 *   -->
 *
 * Matching is prefix-based, vault-relative:
 *   - Pattern ending in `/`  → matches any file under that directory
 *   - Pattern without `/`    → matches that exact path OR a child of that path
 */
import type { StorageBackend } from "./storage.js";

const IGNORE_BLOCK_RE = /<!--\s*TAPROOT-IGNORE\s*\n([\s\S]*?)\n\s*-->/i;

/**
 * Parse the patterns out of CLAUDE.md content. Returns [] if no ignore block
 * or no usable patterns. Stable + pure — no I/O.
 */
export function parseIgnorePatterns(
  claudeMd: string | null | undefined,
): string[] {
  if (!claudeMd) return [];
  const match = IGNORE_BLOCK_RE.exec(claudeMd);
  if (!match) return [];
  return match[1]
    .split("\n")
    .map((line) => {
      // Strip inline comments + trim
      const hash = line.indexOf("#");
      const trimmed = (hash === -1 ? line : line.slice(0, hash)).trim();
      return trimmed;
    })
    .filter((line) => line.length > 0);
}

/**
 * Test whether a vault-relative path matches any of the ignore patterns.
 */
export function pathMatchesIgnore(
  vaultRelativePath: string,
  patterns: string[],
): boolean {
  if (patterns.length === 0) return false;
  for (const p of patterns) {
    if (p.endsWith("/")) {
      // Directory prefix match
      if (vaultRelativePath.startsWith(p)) return true;
    } else {
      // Exact match OR child of (treating pattern as a dir even without slash)
      if (vaultRelativePath === p) return true;
      if (vaultRelativePath.startsWith(p + "/")) return true;
    }
  }
  return false;
}

/**
 * Convenience: load patterns from CLAUDE.md via the backend. Returns [] on
 * any failure (missing file, unreadable, parse error) — never throws.
 */
export async function loadIgnorePatterns(
  backend: StorageBackend,
): Promise<string[]> {
  try {
    if (!(await backend.exists("CLAUDE.md"))) return [];
    const content = await backend.readFile("CLAUDE.md");
    return parseIgnorePatterns(content);
  } catch {
    return [];
  }
}
