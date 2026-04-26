import { z } from "zod";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../utils/storage.js";
import {
  readVaultFile,
  writeVaultFile,
  listVaultFiles,
  searchVault,
  getVaultStats,
  parseFrontmatter,
} from "../utils/vault.js";
import {
  getFilingHintCached,
  invalidateClaudeMdCache,
} from "../utils/cache.js";

export function registerVaultTools(
  server: McpServer,
  backend: StorageBackend,
): void {
  server.registerTool(
    "garden_read",
    {
      title: "Read a note",
      description:
        "Use this whenever the user wants to read, open, or fetch the full content of a known note path. Returns the full file including frontmatter. Triggers: 'open my X note', 'read X.md', 'show me the full content of [path]'. If the user asks about a topic but doesn't give an exact path, call `garden_find` first to locate matches.",
      inputSchema: {
        path: z
          .string()
          .describe("Relative path to the file (e.g. 'notes/my-note.md')"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path: filePath }) => {
      try {
        const content = await readVaultFile(backend, filePath);
        return { content: [{ type: "text", text: content }] };
      } catch (err: any) {
        return {
          content: [
            { type: "text", text: `Error reading file: ${err.message}` },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "garden_plant",
    {
      title: "Save a note",
      description:
        "Use this whenever the user wants to save, write, create, or update any markdown note in their vault. Writes or overwrites a file and creates parent directories automatically. Triggers: 'save this', 'add this to my notes', 'remember this', 'write a note about X', 'update the X note'. The vault's filing conventions (folders, naming, frontmatter) are exposed as the `vault-rules` resource (CLAUDE.md) — read it before writing to an unfamiliar folder. For saving a web page or article URL, prefer `taproot_save_url` (single call: fetch + extract + save).",
      inputSchema: {
        path: z
          .string()
          .describe("Relative path for the file (e.g. 'notes/my-concept.md')"),
        content: z
          .string()
          .describe(
            "Full markdown content to write (including frontmatter if needed)",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path: filePath, content }) => {
      try {
        await writeVaultFile(backend, filePath, content);
        if (filePath === "CLAUDE.md") {
          invalidateClaudeMdCache(backend);
        }
        const hint = await getFilingHintCached(backend, filePath);
        const message = hint
          ? `Written: ${filePath}\n\n${hint}`
          : `Written: ${filePath}`;
        return {
          content: [{ type: "text", text: message }],
        };
      } catch (err: any) {
        return {
          content: [
            { type: "text", text: `Error writing file: ${err.message}` },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "garden_survey",
    {
      title: "Browse your garden",
      description:
        "Use this whenever the user wants to see what's in a folder or list everything in their vault. Returns relative paths of markdown files. Triggers: 'what's in my X folder', 'list everything in my vault', 'show me my notes folder', 'how is my vault structured'. For finding specific notes by topic, prefer `garden_find` (returns matches with previews). For 'recently modified', use `garden_recent`.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Subdirectory to list (e.g. 'sources'). Omit for entire vault.",
          ),
        recursive: z
          .boolean()
          .optional()
          .default(true)
          .describe("Whether to list files in subdirectories (default: true)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path: subPath, recursive }) => {
      try {
        const files = await listVaultFiles(backend, subPath, recursive);
        if (files.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: subPath
                  ? `No markdown files found in ${subPath}/`
                  : "No markdown files found in vault.",
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `${files.length} files:\n${files.join("\n")}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            { type: "text", text: `Error listing files: ${err.message}` },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "garden_forage",
    {
      title: "Search your garden",
      description:
        "Use this whenever the user wants to search inside their notes for a specific phrase, keyword, quote, or concept. Returns matching files with line numbers and context (case-insensitive). Triggers: 'do I have anything on X', 'search my notes for X', 'find every mention of X', 'where did I write about X', 'remember when I said X'. For 'show me a specific note', prefer `garden_find` (title/topic match). For 'recent activity', prefer `garden_recent`.",
      inputSchema: {
        query: z.string().describe("Text to search for"),
        path: z
          .string()
          .optional()
          .describe("Subdirectory to limit search to (e.g. 'notes')"),
        maxResults: z
          .number()
          .optional()
          .default(20)
          .describe("Maximum number of matching files to return (default: 20)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, path: subPath, maxResults }) => {
      try {
        const results = await searchVault(backend, query, {
          subPath,
          maxResults,
        });
        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `No results for "${query}"` }],
          };
        }
        const output = results
          .map((r) => {
            const matchLines = r.matches
              .slice(0, 3)
              .map((m) => `  L${m.line}: ${m.text}`)
              .join("\n");
            return `${r.file} (${r.matches.length} matches)\n${matchLines}`;
          })
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: `${results.length} files match "${query}":\n\n${output}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error searching: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "garden_measure",
    {
      title: "Garden stats",
      description:
        "Use this whenever the user asks for a high-level snapshot of their vault — file counts, folder list, whether Taproot is set up. Triggers: 'how big is my vault', 'how many notes do I have', 'garden stats', 'is my brain set up', 'vault overview'. For a richer status with config + recent activity, prefer `taproot_status`.",
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
        const stats = await getVaultStats(backend);
        return {
          content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting stats: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "garden_tag",
    {
      title: "Read note metadata",
      description:
        "Use this whenever the user asks for the metadata, tags, frontmatter, or properties of a specific note (without reading the body). Returns parsed YAML frontmatter as JSON (title, tags, date, status, etc.). Triggers: 'what are the tags on X', 'show me the metadata for X', 'when was X created', 'is X marked as archived'. For full file content, use `garden_read`.",
      inputSchema: {
        path: z.string().describe("Relative path to the file"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path: filePath }) => {
      try {
        const content = await readVaultFile(backend, filePath);
        const fm = parseFrontmatter(content);
        if (Object.keys(fm).length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No frontmatter found in this file.",
              },
            ],
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(fm, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error reading frontmatter: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── garden_find ──────────────────────────────────────────────────────
  server.registerTool(
    "garden_find",
    {
      title: "Find notes",
      description:
        "Use this FIRST whenever the user asks about a specific note by topic or title (not a phrase search). Returns a ranked list of matches with title, path, and a short preview. If exactly 1 match — call `garden_read` to fetch full content. If multiple matches — show the list and ask which one. Triggers: 'show me my note about X', 'find the X note', 'pull up my X doc', 'where's my note on X', 'open my X'. For phrase/keyword search inside note bodies, use `garden_forage` instead.",
      inputSchema: {
        query: z
          .string()
          .describe("Title fragment, topic, or keyword to find notes by"),
        limit: z
          .number()
          .optional()
          .default(10)
          .describe("Max results to return (default: 10)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit }) => {
      try {
        const max = limit ?? 10;
        const allFiles = await listVaultFiles(backend);
        const lowerQuery = query.toLowerCase();
        const queryWords = lowerQuery.split(/\s+/).filter((w) => w.length >= 2);

        type Match = {
          file: string;
          title: string;
          score: number;
          preview: string;
        };
        const filenameMatches: Match[] = [];

        for (const file of allFiles) {
          const basename = path.basename(file, ".md").toLowerCase();
          const folder = path.dirname(file).toLowerCase();
          let score = 0;

          if (basename === lowerQuery) score += 100;
          if (basename.includes(lowerQuery)) score += 50;
          for (const w of queryWords) {
            if (basename.includes(w)) score += 10;
            if (folder.includes(w)) score += 3;
          }

          if (score > 0) {
            filenameMatches.push({
              file,
              title: path.basename(file, ".md"),
              score,
              preview: "",
            });
          }
        }

        filenameMatches.sort((a, b) => b.score - a.score);

        const candidates = filenameMatches.slice(0, max * 2);
        const results: Match[] = [];

        for (const m of candidates) {
          if (results.length >= max) break;
          try {
            const content = await readVaultFile(backend, m.file);
            const fm = parseFrontmatter(content);
            const fmTitle = typeof fm.title === "string" ? fm.title : null;
            const body = content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
            const previewLine =
              body
                .split("\n")
                .find((l) => l.trim() && !l.startsWith("#"))
                ?.slice(0, 160) || body.slice(0, 160);
            results.push({
              file: m.file,
              title: fmTitle || m.title,
              score: m.score,
              preview: previewLine,
            });
          } catch {
            results.push(m);
          }
        }

        // If no filename hits, fall back to body search via existing search infra
        if (results.length === 0) {
          const searchHits = await searchVault(backend, query, {
            maxResults: max,
          });
          for (const r of searchHits) {
            const firstMatch = r.matches[0]?.text || "";
            results.push({
              file: r.file,
              title: r.title,
              score: 1,
              preview: firstMatch.slice(0, 160),
            });
          }
        }

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No notes found matching "${query}". Try \`garden_forage\` for a full-text search inside note bodies.`,
              },
            ],
          };
        }

        const output = [
          `${results.length} match${results.length === 1 ? "" : "es"} for "${query}":`,
          "",
          ...results.map(
            (r) =>
              `- **${r.title}** — ${r.file}${r.preview ? `\n  > ${r.preview}` : ""}`,
          ),
          "",
          results.length === 1
            ? `Call \`garden_read({ path: "${results[0].file}" })\` to fetch the full note.`
            : "Show the user this list and ask which one to open, or call `garden_read` directly if context makes the choice obvious.",
        ];

        return {
          content: [{ type: "text", text: output.join("\n") }],
        };
      } catch (err: any) {
        return {
          content: [
            { type: "text", text: `Error finding notes: ${err.message}` },
          ],
          isError: true,
        };
      }
    },
  );

  // ── garden_recent ────────────────────────────────────────────────────
  server.registerTool(
    "garden_recent",
    {
      title: "Recent notes",
      description:
        "Use this whenever the user wants to see what they've been working on recently — last edited / last added notes. Returns up to N notes ranked by frontmatter `date_modified` then `date_created`, falling back to file listing order. Triggers: 'what did I work on this week', 'show me my recent notes', 'what was I thinking about lately', 'what did I add today', 'last few notes'.",
      inputSchema: {
        n: z
          .number()
          .optional()
          .default(10)
          .describe("Number of recent notes to return (default 10, max 50)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ n }) => {
      try {
        const limit = Math.min(n ?? 10, 50);
        const allFiles = await listVaultFiles(backend);
        if (allFiles.length === 0) {
          return {
            content: [{ type: "text", text: "No notes in the vault yet." }],
          };
        }

        // Sample up to 3x the limit, read frontmatter, sort by date.
        // Best-effort — full mtime support comes with the Stage 1 backend rewrite.
        const sampleSize = Math.min(allFiles.length, limit * 3);
        const sample = allFiles.slice(0, sampleSize);

        type Item = {
          file: string;
          title: string;
          dateKey: string;
          source: "modified" | "created" | "fallback";
        };
        const items: Item[] = [];

        for (const file of sample) {
          try {
            const content = await readVaultFile(backend, file);
            const fm = parseFrontmatter(content);
            const dateModified = coerceDate(fm.date_modified);
            const dateCreated = coerceDate(fm.date_created);
            const dateKey = dateModified || dateCreated || "";
            const source = dateModified
              ? "modified"
              : dateCreated
                ? "created"
                : "fallback";
            const title =
              typeof fm.title === "string"
                ? fm.title
                : path.basename(file, ".md");
            items.push({ file, title, dateKey, source });
          } catch {
            items.push({
              file,
              title: path.basename(file, ".md"),
              dateKey: "",
              source: "fallback",
            });
          }
        }

        items.sort((a, b) => {
          if (a.dateKey && b.dateKey) return b.dateKey.localeCompare(a.dateKey);
          if (a.dateKey) return -1;
          if (b.dateKey) return 1;
          return 0;
        });

        const top = items.slice(0, limit);
        const hasAnyDate = top.some((i) => i.dateKey);

        const lines = top.map((i) => {
          const dateBadge = i.dateKey
            ? ` (${i.source === "modified" ? "modified" : "created"} ${i.dateKey})`
            : "";
          return `- **${i.title}** — ${i.file}${dateBadge}`;
        });

        const header = hasAnyDate
          ? `${top.length} most recent note${top.length === 1 ? "" : "s"} (by frontmatter date):`
          : `${top.length} note${top.length === 1 ? "" : "s"} (no frontmatter dates found — listing order):`;

        return {
          content: [{ type: "text", text: [header, "", ...lines].join("\n") }],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error listing recent notes: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

function coerceDate(val: unknown): string {
  if (typeof val === "string") return val;
  if (val instanceof Date && !isNaN(val.getTime())) {
    return val.toISOString().slice(0, 10);
  }
  return "";
}
