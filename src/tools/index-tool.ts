import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../utils/storage.js";
import {
  checkToolRateLimit,
  rateLimitToolError,
  respondToolError,
} from "./_rate-limit.js";
import { parseFrontmatter } from "../utils/vault.js";
import {
  extractCardinality,
  renderCardinalityLine,
  MANAGED_INDEX_MARKER,
} from "../utils/frontmatter.js";
import {
  loadIgnorePatterns,
  pathMatchesIgnore,
} from "../utils/taproot-ignore.js";

const INDEX_TTL_MS = 60 * 60 * 1000;
const INDEX_FRESHNESS_DAYS = 7;
const FILES_PER_FOLDER_LIMIT = 20;
const TOTAL_FILE_LIMIT = 1000;
const INDEX_CHAR_BUDGET = 16_000;

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

// Per-workspace debouncer for event-driven cache invalidation (V1.5a.1-C).
// Keyed on workspaceId; stores timer + backend reference for the flush.
interface DebounceEntry {
  timer: ReturnType<typeof setTimeout>;
  backend: StorageBackend;
}

const WORKSPACE_DEBOUNCERS = new Map<string, DebounceEntry>();

/**
 * Invalidate the index cache for a workspace, debounced at 500ms. Multiple
 * upserts within the window collapse to a single regeneration. On flush,
 * evicts the in-memory cache, synthesizes a fresh index, and writes back to
 * `index.md` (unless a user-authored file is present and fresh).
 *
 * Per-workspace isolation: workspace A's upsert ONLY invalidates workspace A.
 */
export function invalidateIndexForWorkspace(
  workspaceId: string,
  backend: StorageBackend,
  debounceMs = 500,
): void {
  if (process.env.INDEX_INVALIDATION_DISABLED === "1") return;

  const existing = WORKSPACE_DEBOUNCERS.get(workspaceId);
  if (existing) {
    clearTimeout(existing.timer);
  }

  const timer = setTimeout(() => {
    WORKSPACE_DEBOUNCERS.delete(workspaceId);
    void flushIndexForWorkspace(workspaceId, backend);
  }, debounceMs);

  WORKSPACE_DEBOUNCERS.set(workspaceId, { timer, backend });
}

/** Export for tests and for backend disposal cleanup. */
export function disposeWorkspaceDebouncer(workspaceId: string): void {
  const existing = WORKSPACE_DEBOUNCERS.get(workspaceId);
  if (existing) {
    clearTimeout(existing.timer);
    WORKSPACE_DEBOUNCERS.delete(workspaceId);
  }
}

async function flushIndexForWorkspace(
  workspaceId: string,
  backend: StorageBackend,
): Promise<void> {
  // 1. Evict in-memory cache
  indexCache.delete(backend);

  // 2. Single pass through the vault — listFiles + per-file readFile happen
  // ONCE. Both renderers (MCP cache + disk write-back) operate off this data.
  let data: IndexData;
  try {
    data = await loadIndexData(backend);
  } catch (err) {
    console.error(
      `[index-tool] index data load failed for workspace ${workspaceId}: ${err}`,
    );
    return;
  }

  // 3. MCP-format goes into the cache for Claude (truncation hints + cardinality)
  const mcpRendered = renderIndexForMcp(data);

  // 4. DISK-format gets written to index.md (clean human-readable per CLAUDE.md spec)
  if (process.env.INDEX_WRITEBACK_DISABLED !== "1") {
    try {
      const diskRendered = renderIndexForDisk(data);
      await maybeWriteIndexMd(backend, diskRendered);
    } catch (err) {
      console.error(
        `[index-tool] write-back failed for workspace ${workspaceId}: ${err}`,
      );
    }
  }

  // 5. Populate cache with the MCP-format result
  const wrapped = wrap(mcpRendered, "synthesized");
  indexCache.set(backend, { rendered: wrapped, cachedAt: Date.now() });
}

/**
 * Write index.md with TAPROOT-MANAGED:index marker. Three-state classifier (L6):
 *   - fresh           → write scaffold (file missing OR <=50 chars trimmed)
 *   - taproot_managed → regenerate (full rebuild; incremental is a follow-up)
 *   - user_owned      → skip silently (never clobber)
 *
 * Returns the resulting state so callers can surface it in setup-scan responses.
 */
const INDEX_FRESH_CHAR_FLOOR = 50;

export type IndexMdState = "fresh" | "taproot_managed" | "user_owned";

async function maybeWriteIndexMd(
  backend: StorageBackend,
  rendered: string,
): Promise<IndexMdState> {
  let existing: string | null = null;
  if (await backend.exists("index.md")) {
    try {
      existing = await backend.readFile("index.md");
    } catch {
      existing = null;
    }
  }

  let state: IndexMdState;
  if (existing == null || existing.trim().length <= INDEX_FRESH_CHAR_FLOOR) {
    state = "fresh";
  } else if (existing.includes(MANAGED_INDEX_MARKER)) {
    state = "taproot_managed";
  } else {
    state = "user_owned";
  }

  if (state === "user_owned") return state;

  const content = `---\n${MANAGED_INDEX_MARKER}: true\n---\n\n${rendered}`;
  await backend.writeFile("index.md", content);
  return state;
}

export function registerIndexTool(
  server: McpServer,
  backend: StorageBackend,
  opts: { workspaceId?: string } = {},
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
      const limited = checkToolRateLimit(
        opts.workspaceId ?? "unknown",
        "garden_index",
        "read",
      );
      if (limited) return rateLimitToolError(limited);
      try {
        // 1. In-memory cache (1h TTL)
        const cached = indexCache.get(backend);
        if (cached && Date.now() - cached.cachedAt < INDEX_TTL_MS) {
          return {
            content: [{ type: "text", text: cached.rendered }],
          };
        }

        // 2+3. Read index.md: managed marker → verbatim; user-authored fresh → verbatim
        const existing = await tryReadFreshIndex(backend);
        if (existing) {
          const wrapped = wrap(existing, "index.md");
          indexCache.set(backend, { rendered: wrapped, cachedAt: Date.now() });
          return { content: [{ type: "text", text: wrapped }] };
        }

        // 4. Single-pass load — both renderers share the same file/content data
        const data = await loadIndexData(backend);
        const mcpRendered = renderIndexForMcp(data);
        const wrapped = wrap(mcpRendered, "synthesized");
        indexCache.set(backend, { rendered: wrapped, cachedAt: Date.now() });

        if (process.env.INDEX_WRITEBACK_DISABLED !== "1") {
          // DISK-format (clean) for the user's vault, computed from the same
          // data we already loaded. No re-read.
          const diskRendered = renderIndexForDisk(data);
          void maybeWriteIndexMd(backend, diskRendered).catch((err) =>
            console.error(`[index-tool] write-back error: ${err}`),
          );
        }

        return { content: [{ type: "text", text: wrapped }] };
      } catch (err) {
        return respondToolError("garden_index_failed", err);
      }
    },
  );
}

function wrap(body: string, source: string): string {
  return `<vault-index source="${source}">\n${body}\n</vault-index>`;
}

/**
 * Read index.md if it should be served verbatim.
 *
 * Priority:
 *   1. Has TAPROOT-MANAGED:index marker → return verbatim (always fresh)
 *   2. No marker, ≤7 days old → return verbatim (user-authored honored)
 *   3. Otherwise null → caller synthesizes
 */
async function tryReadFreshIndex(
  backend: StorageBackend,
): Promise<string | null> {
  if (!(await backend.exists("index.md"))) return null;
  const content = await backend.readFile("index.md");

  // Managed index — always serve it (freshness determined by write-back logic)
  if (content.includes(MANAGED_INDEX_MARKER)) return content;

  // User-authored — serve if within freshness window
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

interface IndexData {
  root: string[];
  groups: Map<string, string[]>;
  contents: Map<string, string | undefined>;
  truncated: boolean;
  totalFiles: number;
}

/**
 * Load the file list + each file's content in a single pass so the two
 * synthesizers (MCP / disk) can render without re-reading. Without this,
 * a flush walks the entire vault twice — 2x the latency on big vaults
 * (Tom's at 800+ files).
 */
async function loadIndexData(backend: StorageBackend): Promise<IndexData> {
  // Load ignore patterns FIRST so we can filter files out before doing the
  // expensive per-file readFile loop. Patterns come from CLAUDE.md's
  // TAPROOT-IGNORE block — see src/utils/taproot-ignore.ts for the contract.
  const ignorePatterns = await loadIgnorePatterns(backend);

  const allUnfiltered = await backend.listFiles();
  const all = allUnfiltered.filter(
    (filePath) => !pathMatchesIgnore(filePath, ignorePatterns),
  );
  const truncated = all.length >= TOTAL_FILE_LIMIT;
  const groups = new Map<string, string[]>();
  const root: string[] = [];
  const contents = new Map<string, string | undefined>();

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
    try {
      contents.set(filePath, await backend.readFile(filePath));
    } catch {
      contents.set(filePath, undefined);
    }
  }
  root.sort();
  for (const arr of groups.values()) arr.sort();
  return { root, groups, contents, truncated, totalFiles: all.length };
}

async function synthesizeIndex(backend: StorageBackend): Promise<string> {
  const data = await loadIndexData(backend);
  return renderIndexForMcp(data);
}

function renderIndexForMcp(data: IndexData): string {
  if (data.totalFiles === 0) {
    return "# Vault index\n\n(empty vault — no markdown files yet)";
  }
  const folders = [...data.groups.keys()].sort();
  const lines: string[] = [`# Vault index`, ""];

  if (data.truncated) {
    lines.push(
      `> Showing first ${TOTAL_FILE_LIMIT} files. Vault may have more — call \`garden_survey({ path: "<folder>" })\` for full folder contents.`,
      "",
    );
  }

  if (data.root.length > 0) {
    lines.push(
      `## (root)`,
      ...renderFolderSliceForMcp(data.root, data.contents),
      "",
    );
  }

  for (const folder of folders) {
    const files = data.groups.get(folder) ?? [];
    lines.push(
      `## ${folder}/`,
      ...renderFolderSliceForMcp(files, data.contents),
      "",
    );
  }

  const raw = lines.join("\n").trimEnd() + "\n";
  return applyCharBudget(raw, data.groups);
}

function renderFolderSliceForMcp(
  files: string[],
  contents: Map<string, string | undefined>,
): string[] {
  const sliced = files.slice(0, FILES_PER_FOLDER_LIMIT);
  const rendered: string[] = sliced.map((f) =>
    buildFileEntry(f, contents.get(f)),
  );

  if (files.length > FILES_PER_FOLDER_LIMIT) {
    const folder = files[0].includes("/") ? path.dirname(files[0]) : ".";
    rendered.push(
      `- _(${files.length - FILES_PER_FOLDER_LIMIT} more in this folder — call \`garden_survey({ path: "${folder}" })\`)_`,
    );
  }

  return rendered;
}

/**
 * Synthesize the human-readable index.md that gets written to the vault on
 * disk. Distinct from `synthesizeIndex` (which is the MCP tool response):
 *
 *   - No truncation hints (no "_(N more in this folder — call garden_survey)_")
 *   - No char-budget truncation stubs
 *   - No cardinality dumps in the entry line
 *   - No raw file path — just the wikilink + one-line summary
 *   - No per-folder limit — lists every file under each top-level folder
 *
 * Format matches the CLAUDE.md spec exactly:
 *   - [[<wikilink>]] — <one-line summary>
 */
async function synthesizeIndexForDisk(
  backend: StorageBackend,
): Promise<string> {
  const data = await loadIndexData(backend);
  return renderIndexForDisk(data);
}

// Temporal folders excluded from the disk-written index.md.
// These are high-volume, date-ordered — discoverable via garden_recent, not index lookup.
const INDEX_DISK_EXCLUDE_FOLDERS = new Set(["daily"]);

function renderIndexForDisk(data: IndexData): string {
  if (data.totalFiles === 0) {
    return "# Vault index\n\n(empty vault — no markdown files yet)\n";
  }
  const folders = [...data.groups.keys()].sort();
  const lines: string[] = ["# Vault index", ""];

  if (data.root.length > 0) {
    lines.push(
      `## (root)`,
      ...data.root.map((f) => buildFileEntryForDisk(f, data.contents.get(f))),
      "",
    );
  }

  for (const folder of folders) {
    if (INDEX_DISK_EXCLUDE_FOLDERS.has(folder)) continue;
    const files = data.groups.get(folder) ?? [];
    lines.push(
      `## ${folder}/`,
      ...files.map((f) => buildFileEntryForDisk(f, data.contents.get(f))),
      "",
    );
  }

  return lines.join("\n").trimEnd() + "\n";
}

function buildFileEntryForDisk(
  filePath: string,
  content: string | undefined,
): string {
  const base = path.basename(filePath, ".md");
  let summaryText = "(no description)";

  if (content !== undefined && content.trim()) {
    const card = extractCardinality(content);
    summaryText =
      card.summary ??
      extractFirstH1(content) ??
      truncateText(stripFrontmatter(content), 100) ??
      "(no description)";
    // CLAUDE.md spec: one-line summary under ~100 chars.
    summaryText = truncateText(summaryText, 100) ?? summaryText;
  }

  return `- [[${base}]] — ${summaryText}`;
}

function buildFileEntry(filePath: string, content: string | undefined): string {
  const base = path.basename(filePath, ".md");
  let cardLine = "";
  let summaryText = "(no description)";

  if (content !== undefined && content.trim()) {
    const card = extractCardinality(content);
    const rendered = renderCardinalityLine(card);
    if (rendered) cardLine = rendered;

    summaryText =
      card.summary ??
      extractFirstH1(content) ??
      truncateText(stripFrontmatter(content), 80) ??
      "(no description)";
  }

  const parts: string[] = [`- [[${base}]] — \`${filePath}\``];
  if (cardLine) parts.push(cardLine);
  parts.push(`— ${summaryText}`);

  return parts.join(" ");
}

function extractFirstH1(content: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(content);
  return match ? match[1].trim() : undefined;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---[\s\S]*?---\n/, "").trim();
}

function truncateText(text: string, maxLen: number): string | undefined {
  if (!text) return undefined;
  const normalized = text.replace(/\n+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > maxLen
    ? normalized.slice(0, maxLen) + "…"
    : normalized;
}

/**
 * Apply 16_000-char budget. If the rendered index exceeds the cap, replace the
 * deepest-nested folder sections with stubs (visible to Claude, tiny footprint)
 * rather than silently dropping them.
 */
function applyCharBudget(
  rendered: string,
  groups: Map<string, string[]>,
): string {
  if (rendered.length <= INDEX_CHAR_BUDGET) return rendered;

  const lines = rendered.split("\n");
  const preamble: string[] = [];

  interface Section {
    header: string;
    label: string;
    body: string[];
    depth: number;
    truncated?: boolean;
  }

  const sections: Section[] = [];
  let cur: Section | null = null;

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (cur) sections.push(cur);
      const label = line.slice(3).replace(/\/$/, "");
      const depth = label === "(root)" ? 0 : label.split("/").length;
      cur = { header: line, label, body: [], depth };
    } else if (cur) {
      cur.body.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (cur) sections.push(cur);

  const build = (secs: Section[]): string => {
    const parts = [...preamble];
    for (const s of secs) {
      parts.push(s.header, ...s.body);
    }
    return parts.join("\n").trimEnd() + "\n";
  };

  const remaining = [...sections];

  while (remaining.length > 0) {
    const attempt = build(remaining);
    if (attempt.length <= INDEX_CHAR_BUDGET) break;
    // Replace the deepest non-truncated section with a stub.
    const candidates = remaining
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => !s.truncated);
    if (candidates.length === 0) break; // preamble alone exceeds budget; can't shrink further
    const maxDepth = Math.max(...candidates.map((c) => c.s.depth));
    const last = [...candidates].reverse().find((c) => c.s.depth === maxDepth)!;
    const fileCount = groups.get(last.s.label)?.length ?? 0;
    remaining[last.i] = {
      ...last.s,
      body: [
        `*Truncated — ${fileCount} file${fileCount === 1 ? "" : "s"}. Call \`garden_survey\` for details.*`,
        "",
      ],
      truncated: true,
    };
  }

  return build(remaining);
}
