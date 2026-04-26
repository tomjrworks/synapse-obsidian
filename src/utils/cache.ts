import type { StorageBackend } from "./storage.js";

const CACHE_TTL_MS = 5 * 60 * 1000;

interface ClaudeMdCacheEntry {
  content: string | null;
  loadedAt: number;
  filingHints: Map<string, string | null>;
}

const claudeMdCache = new WeakMap<StorageBackend, ClaudeMdCacheEntry>();

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readClaudeMd(backend: StorageBackend): Promise<string | null> {
  const entry = claudeMdCache.get(backend);
  if (entry && Date.now() - entry.loadedAt < CACHE_TTL_MS) {
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
  claudeMdCache.set(backend, {
    content,
    loadedAt: Date.now(),
    filingHints: new Map(),
  });
  return content;
}

export async function getFilingHintCached(
  backend: StorageBackend,
  filePath: string,
): Promise<string | null> {
  const topLevel = filePath.split("/")[0];
  if (!topLevel || topLevel === filePath) return null;

  const claude = await readClaudeMd(backend);
  if (!claude) return null;

  const entry = claudeMdCache.get(backend);
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

export function invalidateClaudeMdCache(backend: StorageBackend): void {
  claudeMdCache.delete(backend);
}
