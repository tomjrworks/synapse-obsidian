import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../utils/storage.js";
import { parseFrontmatter } from "../utils/vault.js";

const INDEX_TTL_MS = 60 * 60 * 1000;
const INDEX_FRESHNESS_DAYS = 7;
const FILES_PER_FOLDER_LIMIT = 20;
const TOTAL_FILE_LIMIT = 1000;

interface IndexCacheEntry {
  rendered: string;
  cachedAt: number;
}

const indexCache = new WeakMap<StorageBackend, IndexCacheEntry>();

/** Test seam — vitest needs a way to reset the WeakMap-backed cache between
 * cases when reusing a backend reference, but in practice each test makes a
 * fresh backend so this is rarely needed. Exported for future suites. */
export function _clearIndexCache(backend: StorageBackend): void {
  indexCache.delete(backend);
}

export function registerIndexTool(
  server: McpServer,
  backend: StorageBackend,
): void {
  server.registerTool(
    "garden_index",
    {
      title: "Vault map",
      description:
        "Use this when the user asks about projects, past work, or 'what do you know about X' — the index is the entry point before searching or reading specific files. Returns a markdown map of the vault organized by top-level folder, with note titles. For high-volume folders, lists the first batch + a count of the rest. Triggers: 'what's in my vault', 'what projects am I working on', 'show me everything you know about X', 'where would X live in my vault'. For full-text search inside notes, use garden_forage. For a single note by title, use garden_find.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const cached = indexCache.get(backend);
        if (cached && Date.now() - cached.cachedAt < INDEX_TTL_MS) {
          return {
            content: [{ type: "text", text: cached.rendered }],
          };
        }

        const existing = await tryReadFreshIndex(backend);
        if (existing) {
          const wrapped = wrap(existing, "index.md");
          indexCache.set(backend, { rendered: wrapped, cachedAt: Date.now() });
          return { content: [{ type: "text", text: wrapped }] };
        }

        const synthesized = await synthesizeIndex(backend);
        const wrapped = wrap(synthesized, "synthesized");
        indexCache.set(backend, { rendered: wrapped, cachedAt: Date.now() });
        return { content: [{ type: "text", text: wrapped }] };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error building vault index: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

function wrap(body: string, source: string): string {
  return `<vault-index source="${source}">\n${body}\n</vault-index>`;
}

async function tryReadFreshIndex(
  backend: StorageBackend,
): Promise<string | null> {
  if (!(await backend.exists("index.md"))) return null;
  const content = await backend.readFile("index.md");
  const fm = parseFrontmatter(content);
  const raw = fm.date_modified ?? fm.modified ?? fm.last_updated;
  if (raw == null) return null;
  const ts = parseDateValue(raw);
  if (ts == null) return null;
  const ageMs = Date.now() - ts;
  if (ageMs < 0 || ageMs > INDEX_FRESHNESS_DAYS * 24 * 60 * 60 * 1000) {
    return null;
  }
  return content;
}

function parseDateValue(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") {
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

async function synthesizeIndex(backend: StorageBackend): Promise<string> {
  const all = await backend.listFiles();
  const truncated = all.length >= TOTAL_FILE_LIMIT;

  if (all.length === 0) {
    return "# Vault index\n\n(empty vault — no markdown files yet)";
  }

  const groups = new Map<string, string[]>();
  const root: string[] = [];
  for (const filePath of all) {
    const slash = filePath.indexOf("/");
    if (slash === -1) {
      root.push(filePath);
    } else {
      const folder = filePath.slice(0, slash);
      const arr = groups.get(folder) ?? [];
      arr.push(filePath);
      groups.set(folder, arr);
    }
  }

  const folders = [...groups.keys()].sort();
  const lines: string[] = [`# Vault index`, ""];

  if (truncated) {
    lines.push(
      `> Showing first ${TOTAL_FILE_LIMIT} files. Vault may have more — call \`garden_survey({ path: "<folder>" })\` for full folder contents.`,
      "",
    );
  }

  if (root.length > 0) {
    lines.push(`## (root)`, ...renderFolderSlice(root), "");
  }

  for (const folder of folders) {
    const files = (groups.get(folder) ?? []).sort();
    lines.push(`## ${folder}/`, ...renderFolderSlice(files), "");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function renderFolderSlice(files: string[]): string[] {
  const sliced = files.slice(0, FILES_PER_FOLDER_LIMIT);
  const rendered = sliced.map((f) => {
    const base = path.basename(f, ".md");
    return `- [[${base}]] — \`${f}\``;
  });
  if (files.length > FILES_PER_FOLDER_LIMIT) {
    rendered.push(
      `- _(${files.length - FILES_PER_FOLDER_LIMIT} more in this folder — call \`garden_survey({ path: "${path.dirname(files[0])}" })\`)_`,
    );
  }
  return rendered;
}
