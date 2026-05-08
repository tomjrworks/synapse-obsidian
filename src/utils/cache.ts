import { LRUCache } from "lru-cache";
import type { StorageBackend } from "./storage.js";

const CACHE_TTL_MS = 5 * 60 * 1000;

/** Tenant key for stdio mode (Claude Desktop / Claude Code, single LocalBackend). */
export const LOCAL_TENANT_KEY = "local";

interface ClaudeMdCacheEntry {
  content: string | null;
  loadedAt: number;
  filingHints: Map<string, string | null>;
}

// Keyed by tenantKey ("local" for stdio, workspace_id UUID in cloud) so the
// cache outlives any single backend instance — important once src/server.ts
// (Stage 1 T6) caches backends per workspace_id and may evict them while
// active sessions still hold references. Bounded by active-tenant count
// during the 5-min TTL window; if that ever needs an LRU, add one.
const claudeMdCache = new LRUCache<string, ClaudeMdCacheEntry>({
  max: 5_000,
  ttl: CACHE_TTL_MS,
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readClaudeMd(
  backend: StorageBackend,
  tenantKey: string,
): Promise<string | null> {
  const entry = claudeMdCache.get(tenantKey);
  if (entry) {
    return entry.content;
  }
  let content: string | null = null;
  try {
    if (await backend.exists("CLAUDE.md")) {
      content = await backend.readFile("CLAUDE.md");
    }
  } catch {
    content = null;
  }
  claudeMdCache.set(tenantKey, {
    content,
    loadedAt: Date.now(),
    filingHints: new Map(),
  });
  return content;
}

export async function getFilingHintCached(
  backend: StorageBackend,
  tenantKey: string,
  filePath: string,
): Promise<string | null> {
  const topLevel = filePath.split("/")[0];
  if (!topLevel || topLevel === filePath) return null;

  const claude = await readClaudeMd(backend, tenantKey);
  if (!claude) return null;

  const entry = claudeMdCache.get(tenantKey);
  if (entry?.filingHints.has(topLevel)) {
    return entry.filingHints.get(topLevel) ?? null;
  }

  const pattern = new RegExp(`(?:^|[^\\w-])${escapeRegex(topLevel)}/`);
  const matches = claude
    .split("\n")
    .filter((line) => pattern.test(line))
    .slice(0, 3);

  const hint =
    matches.length === 0
      ? null
      : `Filing rules for \`${topLevel}/\`:\n${matches.join("\n")}\n\n(Full rules: read resource \`vault://CLAUDE.md\`.)`;

  if (entry) entry.filingHints.set(topLevel, hint);
  return hint;
}

export function invalidateClaudeMdCache(tenantKey: string): void {
  claudeMdCache.delete(tenantKey);
}
