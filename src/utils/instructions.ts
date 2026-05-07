import type { StorageBackend } from "./storage.js";

const MAX_INSTRUCTIONS_BYTES = 1500;

const PREAMBLE = [
  "You're working in a Taproot vault — the user's memory layer for AI.",
  "The vault is their long-term memory. Treat saves as durable, not chat scratch.",
].join("\n");

const POINTERS = [
  "When you need vault context, use these tools (cheap, scoped to this user):",
  "- garden_rules — fetch CLAUDE.md filing rules. Call BEFORE saving in unfamiliar folders.",
  "- garden_index — vault map by folder. Call when the user asks about projects or past work.",
  "- garden_recent — recent notes by mtime. Call for 'what was I working on'.",
  "- garden_plant — save a note. Helper syncs to Obsidian within ~30s after the call returns.",
].join("\n");

const BEHAVIOR = [
  "After meaningful exchanges (a decision, milestone, research synthesis), proactively call",
  "garden_plant to save — don't wait to be asked. Mark superseded notes with",
  "`status: killed` in frontmatter rather than deleting them.",
].join("\n");

export interface AssembleOptions {
  /** Workspace ID for cloud-mode multi-tenant cache scoping. Optional in stdio mode. */
  workspaceId?: string;
  /** Override clock for tests. */
  now?: () => number;
}

/**
 * Assembles the MCP `initialize.instructions` payload for a single client
 * connection. Layered so a mid-payload truncation by a strict client still
 * leaves the most important parts (preamble + pointers) intact.
 *
 * Budget: 1500 bytes. Headroom under Claude Code's 2KB instructions cap and
 * accounts for the spec ambiguity around byte-count vs character-count.
 *
 * Falls back gracefully on backend errors — instructions is a bonus payload
 * (L1/L11), not a load-bearing surface, so a degraded payload is preferable
 * to a failed handshake.
 */
export async function assembleInstructions(
  backend: StorageBackend,
  opts: AssembleOptions = {},
): Promise<string> {
  const sections: string[] = [PREAMBLE, POINTERS, BEHAVIOR];

  const context = await safeBuildWorkspaceContext(backend);
  if (context) sections.push(context);

  const joined = sections.join("\n\n");
  return truncateToBytes(joined, MAX_INSTRUCTIONS_BYTES);
}

async function safeBuildWorkspaceContext(
  backend: StorageBackend,
): Promise<string | null> {
  try {
    const recent = await backend.recentFiles(50);
    if (recent.length === 0) return null;

    const folderCounts = new Map<string, number>();
    for (const filePath of recent) {
      const slash = filePath.indexOf("/");
      const folder = slash === -1 ? "(root)" : filePath.slice(0, slash);
      folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
    }

    const top = [...folderCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!top) return null;

    return `This vault has activity in the last ${recent.length} touched files; the most active folder is \`${top[0]}/\`.`;
  } catch {
    return null;
  }
}

function truncateToBytes(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= maxBytes) return s;
  // Truncate by character with a margin then verify; binary-search-light.
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi + 1) / 2);
    if (enc.encode(s.slice(0, mid)).length <= maxBytes - 1) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return s.slice(0, lo);
}
