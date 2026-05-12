import { z } from "zod";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../utils/storage.js";
import {
  checkToolRateLimit,
  rateLimitToolError,
  respondToolError,
} from "./_rate-limit.js";
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
  LOCAL_TENANT_KEY,
} from "../utils/cache.js";
import { checkProtected } from "../utils/path-guard.js";
import {
  loadIgnorePatterns,
  pathMatchesIgnore,
} from "../utils/taproot-ignore.js";

export function registerVaultTools(
  server: McpServer,
  backend: StorageBackend,
  opts: { workspaceId?: string } = {},
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
      const limited = checkToolRateLimit(
        opts.workspaceId ?? "unknown",
        "garden_read",
        "read",
      );
      if (limited) return rateLimitToolError(limited);
      try {
        const content = await readVaultFile(backend, filePath);
        return {
          content: [
            {
              type: "text",
              text: `<vault-file path="${filePath}">\n${content}\n</vault-file>`,
            },
          ],
        };
      } catch (err) {
        return respondToolError("garden_read_failed", err);
      }
    },
  );

  server.registerTool(
    "garden_plant",
    {
      title: "Save a note",
      description:
        "Save proactively after decisions, research synthesis, templates, lessons, or completed work — don't wait to be asked. After saving, add a small note at the bottom of your response: *Saved to `path/file.md` — move it if you'd like.* For ambiguous cases (half-baked ideas, personal notes, unclear folder fit), ask first with a suggested path: *Worth keeping? I'd file it as `notes/x.md`.*\n\nUse this whenever the user wants to save, write, create, or update any markdown note in their vault. Writes or overwrites a file and creates parent directories automatically. Triggers: 'save this', 'add this to my notes', 'remember this', 'write a note about X', 'update the X note'. The vault's filing conventions (folders, naming, frontmatter) are exposed as the `vault-rules` resource (CLAUDE.md) — read it before writing to an unfamiliar folder. For saving a web page or article URL, prefer `taproot_save_url` (single call: fetch + extract + save). CURATION PATH: when the user has agreed to codify a filing pattern as a CLAUDE.md rule (offered after 3+ consistent saves — see garden_rules), call this with path: 'CLAUDE.md', acknowledgeRoot: true, and the merged content (CLAUDE.md updated between TAPROOT-MANAGED markers; user hand-edits outside markers are preserved by the merge writer). WARNING: This tool can write to protected vault config files (CLAUDE.md, index.md, .taproot/config.json). Writing to these paths will overwrite persistent AI instructions or vault configuration — only do so with explicit user consent, and set acknowledgeRoot: true.",
      inputSchema: {
        path: z
          .string()
          .describe("Relative path for the file (e.g. 'notes/my-concept.md')"),
        content: z
          .string()
          .max(50_000_000)
          .describe(
            "Full markdown content to write (including frontmatter if needed)",
          ),
        acknowledgeRoot: z
          .boolean()
          .optional()
          .describe(
            "Must be true when writing to a protected path (CLAUDE.md, index.md, .taproot/config.json). Omit for normal notes.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path: filePath, content, acknowledgeRoot }) => {
      const limited = checkToolRateLimit(
        opts.workspaceId ?? "unknown",
        "garden_plant",
        "write",
      );
      if (limited) return rateLimitToolError(limited);
      // H1 (05-05): guard persistent-instruction files against unacknowledged
      // overwrites via canonical-form Set check. Closes raw-string-match bypasses
      // (`./CLAUDE.md`, case folding on APFS, trailing-slash, traversal,
      // backslash, basename-anywhere for nested CLAUDE.md). See
      // `src/utils/path-guard.ts` and `scripts/test-protected-paths.ts`.
      const guard = checkProtected(filePath);

      if (guard.kind === "invalid") {
        return {
          content: [
            {
              type: "text",
              text: `Invalid path '${filePath}': ${guard.reason}`,
            },
          ],
          isError: true,
        };
      }

      if (guard.kind === "protected") {
        if (acknowledgeRoot !== true) {
          return {
            content: [
              {
                type: "text",
                text: `Writing to '${filePath}' is protected (resolves to '${guard.canonical}'). This file contains persistent AI instructions or vault configuration. To proceed, re-call garden_plant with acknowledgeRoot: true and explicit user consent.`,
              },
            ],
            isError: true,
          };
        }
        // Reject acknowledged non-canonical writes: on case-sensitive filesystems
        // (Linux/Railway) `claude.md` + ack=true would otherwise pass the gate
        // and silently create a sibling lowercase file rather than touching the
        // real CLAUDE.md the caller intends.
        const isCanonical =
          filePath === guard.canonical || filePath === "CLAUDE.md";
        if (!isCanonical) {
          return {
            content: [
              {
                type: "text",
                text: `Path '${filePath}' is non-canonical for protected file '${guard.canonical}'. Re-call with the canonical path (e.g. 'CLAUDE.md', 'index.md', '.taproot/config.json' — or for nested CLAUDE.md, the exact intended path).`,
              },
            ],
            isError: true,
          };
        }
      }

      try {
        await writeVaultFile(backend, filePath, content);
        if (filePath === "CLAUDE.md") {
          invalidateClaudeMdCache(LOCAL_TENANT_KEY);
        }
        const hint = await getFilingHintCached(
          backend,
          LOCAL_TENANT_KEY,
          filePath,
        );
        const message = hint
          ? `Written: ${filePath}\n\n${hint}`
          : `Written: ${filePath}`;
        return {
          content: [{ type: "text", text: message }],
        };
      } catch (err) {
        return respondToolError("garden_plant_failed", err);
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
      const limited = checkToolRateLimit(
        opts.workspaceId ?? "unknown",
        "garden_survey",
        "read",
      );
      if (limited) return rateLimitToolError(limited);
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
      } catch (err) {
        return respondToolError("garden_survey_failed", err);
      }
    },
  );

  server.registerTool(
    "garden_forage",
    {
      title: "Search your garden",
      description:
        "CONTEXT LOADING FALLBACK: If garden_find returns thin results on a session that implies prior work or continuity, follow with garden_forage to search note bodies. The pair covers intent-based context loading: garden_find first (title match), garden_forage second (body search).\n\nUse this whenever the user wants to search inside their notes for a specific phrase, keyword, quote, or concept. Returns matching files with line numbers and context (case-insensitive). Triggers: 'do I have anything on X', 'search my notes for X', 'find every mention of X', 'where did I write about X', 'remember when I said X'. For 'show me a specific note', prefer `garden_find` (title/topic match). For 'recent activity', prefer `garden_recent`.",
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
      const limited = checkToolRateLimit(
        opts.workspaceId ?? "unknown",
        "garden_forage",
        "read",
      );
      if (limited) return rateLimitToolError(limited);
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
            return `<vault-file path="${r.file}">\n${r.file} (${r.matches.length} matches)\n${matchLines}\n</vault-file>`;
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
      } catch (err) {
        return respondToolError("garden_find_failed", err);
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
      const limited = checkToolRateLimit(
        opts.workspaceId ?? "unknown",
        "garden_measure",
        "read",
      );
      if (limited) return rateLimitToolError(limited);
      try {
        const stats = await getVaultStats(backend);
        return {
          content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
        };
      } catch (err) {
        return respondToolError("garden_stats_failed", err);
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
      const limited = checkToolRateLimit(
        opts.workspaceId ?? "unknown",
        "garden_tag",
        "read",
      );
      if (limited) return rateLimitToolError(limited);
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
      } catch (err) {
        return respondToolError("garden_frontmatter_failed", err);
      }
    },
  );

  // ── garden_find ──────────────────────────────────────────────────────
  server.registerTool(
    "garden_find",
    {
      title: "Find notes",
      description:
        "CONTEXT LOADING: When a session opens with a message that references a project, prior work, a topic, or anything implying continuity — even implicitly — call garden_find immediately before responding. Intent-based, not phrase-based; don't wait for a trigger phrase. If results are thin, follow with garden_forage (body search).\n\nUse this FIRST whenever the user asks about a specific note by topic or title (not a phrase search). Returns a ranked list of matches with title, path, and a short preview. If exactly 1 match — call `garden_read` to fetch full content. If multiple matches — show the list and ask which one. Triggers: 'show me my note about X', 'find the X note', 'pull up my X doc', 'where's my note on X', 'open my X'. For phrase/keyword search inside note bodies, use `garden_forage` instead.",
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
      const limited = checkToolRateLimit(
        opts.workspaceId ?? "unknown",
        "garden_find",
        "read",
      );
      if (limited) return rateLimitToolError(limited);
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
              `- **${r.title}** — ${r.file}${r.preview ? `\n  <vault-file path="${r.file}">${r.preview}</vault-file>` : ""}`,
          ),
          "",
          results.length === 1
            ? `Call \`garden_read({ path: "${results[0].file}" })\` to fetch the full note.`
            : "Show the user this list and ask which one to open, or call `garden_read` directly if context makes the choice obvious.",
        ];

        return {
          content: [{ type: "text", text: output.join("\n") }],
        };
      } catch (err) {
        return respondToolError("garden_search_failed", err);
      }
    },
  );

  // ── garden_recent ────────────────────────────────────────────────────
  server.registerTool(
    "garden_recent",
    {
      title: "Recent notes",
      description:
        "Use this whenever the user wants to see what they've been working on recently — last edited / last added notes. Returns up to N notes ranked by file modification time (newest first). Triggers: 'what did I work on this week', 'show me my recent notes', 'what was I thinking about lately', 'what did I add today', 'last few notes'.",
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
      const limited = checkToolRateLimit(
        opts.workspaceId ?? "unknown",
        "garden_recent",
        "read",
      );
      if (limited) return rateLimitToolError(limited);
      try {
        const limit = Math.min(n ?? 10, 50);
        const recent = await backend.recentFiles(limit);
        if (recent.length === 0) {
          return {
            content: [{ type: "text", text: "No notes in the vault yet." }],
          };
        }

        const lines: string[] = [];
        for (const file of recent) {
          let title = path.basename(file, ".md");
          try {
            const content = await readVaultFile(backend, file);
            const fm = parseFrontmatter(content);
            if (typeof fm.title === "string" && fm.title.length > 0) {
              title = fm.title;
            }
          } catch {
            // title falls back to basename
          }
          lines.push(`- **${title}** — ${file}`);
        }

        const header = `${recent.length} most recent note${recent.length === 1 ? "" : "s"} (by mtime):`;
        return {
          content: [{ type: "text", text: [header, "", ...lines].join("\n") }],
        };
      } catch (err) {
        return respondToolError("garden_recent_failed", err);
      }
    },
  );

  // ── garden_delete ────────────────────────────────────────────────────
  server.registerTool(
    "garden_delete",
    {
      title: "Delete a note",
      description:
        "Use this when the user wants to delete, remove, or trash a note in their vault. Hard-deletes the file at the given path (helper will sync the deletion to local Obsidian). For soft-delete (preserve historical content but mark as superseded — see CLAUDE.md 'Marking dead / superseded content' convention), use `garden_plant` to rewrite the file with `status: killed` frontmatter and an ⚠️ ARCHIVED banner instead. Triggers: 'delete this note', 'remove the X note', 'trash that', 'get rid of [path]', 'undo that save'. Refuses to delete protected paths (CLAUDE.md, index.md, .taproot/config.json). Refuses paths matching the vault's TAPROOT-IGNORE patterns. Refuses to delete folders or .taproot/ internal state.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Relative path of the note to delete (e.g. 'inbox/test-note.md')",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path: filePath }) => {
      const limited = checkToolRateLimit(
        opts.workspaceId ?? "unknown",
        "garden_delete",
        "write",
      );
      if (limited) return rateLimitToolError(limited);

      // 1. Protected-path guard (CLAUDE.md / index.md / .taproot/config.json)
      const guard = checkProtected(filePath);
      if (guard.kind === "invalid") {
        return {
          content: [
            {
              type: "text",
              text: `Invalid path '${filePath}': ${guard.reason}`,
            },
          ],
          isError: true,
        };
      }
      if (guard.kind === "protected") {
        return {
          content: [
            {
              type: "text",
              text: `Refusing to delete '${filePath}' — protected vault config (resolves to '${guard.canonical}'). These files hold persistent AI instructions or workspace state and must not be deleted via tool calls.`,
            },
          ],
          isError: true,
        };
      }

      // 2. Refuse anything inside .taproot/ (workspace state)
      if (filePath.startsWith(".taproot/") || filePath === ".taproot") {
        return {
          content: [
            {
              type: "text",
              text: `Refusing to delete '${filePath}' — '.taproot/' holds workspace state managed by the helper. Deleting it would unpair the vault.`,
            },
          ],
          isError: true,
        };
      }

      // 3. Refuse to act on TAPROOT-IGNORE'd paths (CRM-row dumps, etc.)
      const ignorePatterns = await loadIgnorePatterns(backend);
      if (pathMatchesIgnore(filePath, ignorePatterns)) {
        return {
          content: [
            {
              type: "text",
              text: `Refusing to delete '${filePath}' — matches a TAPROOT-IGNORE pattern in CLAUDE.md. These paths are excluded from AI management by the user's explicit configuration.`,
            },
          ],
          isError: true,
        };
      }

      // 4. Only delete .md files (refuses folders, non-markdown blobs)
      if (!filePath.toLowerCase().endsWith(".md")) {
        return {
          content: [
            {
              type: "text",
              text: `Refusing to delete '${filePath}' — only .md notes can be deleted via this tool. For folders or other file types, the user should delete in Finder / Obsidian directly.`,
            },
          ],
          isError: true,
        };
      }

      // 5. Verify the file exists before deleting (clearer error than backend's)
      const exists = await backend.exists(filePath).catch(() => false);
      if (!exists) {
        return {
          content: [
            {
              type: "text",
              text: `No file at '${filePath}'. Nothing to delete. Use \`garden_find\` to locate the note's actual path.`,
            },
          ],
          isError: true,
        };
      }

      try {
        await backend.delete(filePath);
        return {
          content: [
            {
              type: "text",
              text: `Deleted: ${filePath}\n\nThe helper will sync this deletion to your local Obsidian vault within ~30s. To restore, the file is in your OS trash (Mac: Cmd+Z in Finder while the trash is open, or check Time Machine).`,
            },
          ],
        };
      } catch (err) {
        return respondToolError("garden_delete_failed", err);
      }
    },
  );
}
