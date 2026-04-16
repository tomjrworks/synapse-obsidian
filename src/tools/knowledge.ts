import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import type { StorageBackend } from "../utils/storage.js";
import {
  readVaultFile,
  writeVaultFile,
  listVaultFiles,
  searchVault,
  parseFrontmatter,
} from "../utils/vault.js";
import { loadConfig, getDefaultConfig } from "../utils/config.js";

const TODAY = () => new Date().toISOString().split("T")[0];

const SETUP_TIP =
  "\n\n> **Tip:** Run `synapse_setup` to configure Synapse for your vault.";

/**
 * Strip HTML tags and decode common entities to get plain text.
 * Intentionally simple — the AI will process the content during ingest anyway.
 */
function htmlToText(html: string): string {
  let text = html;

  // Remove script and style blocks entirely
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<header[\s\S]*?<\/header>/gi, "");

  // Convert common block elements to newlines
  text = text.replace(/<\/?(p|div|br|h[1-6]|li|tr|blockquote)[^>]*>/gi, "\n");
  text = text.replace(/<\/?(ul|ol|table|thead|tbody)[^>]*>/gi, "\n");

  // Convert headings with markdown markers
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");

  // Strip all remaining tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&#(\d+);/g, (_m, code) =>
    String.fromCharCode(parseInt(code, 10)),
  );

  // Normalize whitespace: collapse runs of spaces/tabs, collapse 3+ newlines to 2
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text;
}

export function registerKnowledgeTools(
  server: McpServer,
  backend: StorageBackend,
): void {
  // ── synapse_save ────────────────────────────────────────────────────
  server.tool(
    "synapse_save",
    `Save content to the vault's sources folder from a URL or pasted text. Ideal for mobile users who find articles and want to save them without a web clipper.

If a URL is provided, fetches the page and converts it to markdown. If content is provided directly, saves it as-is. Always adds frontmatter with metadata.`,
    {
      title: z.string().describe("Title for the saved note"),
      url: z
        .string()
        .optional()
        .describe("URL to fetch and convert to markdown"),
      content: z
        .string()
        .optional()
        .describe("Raw text or markdown content to save directly"),
      folder: z
        .string()
        .optional()
        .describe("Where to save, relative to vault root (default: 'sources')"),
    },
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ title, url, content, folder }) => {
      try {
        if (!url && !content) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Provide either a `url` to fetch or `content` to save directly.",
              },
            ],
            isError: true,
          };
        }

        const config = await loadConfig(backend);
        const defaults = getDefaultConfig();
        const targetFolder =
          folder || config?.sourcesFolder || defaults.sourcesFolder;
        const filename = slugify(title) + ".md";
        const filePath = `${targetFolder}/${filename}`;

        let body: string;
        let sourceUrl = url || "";

        if (url) {
          try {
            const response = await fetch(url, {
              headers: {
                "User-Agent":
                  "Mozilla/5.0 (compatible; Synapse/1.0; +https://github.com/tomjrworks/synapse-obsidian)",
                Accept: "text/html,application/xhtml+xml,text/plain,*/*",
              },
              signal: AbortSignal.timeout(15000),
            });

            if (!response.ok) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error fetching URL: HTTP ${response.status} ${response.statusText}`,
                  },
                ],
                isError: true,
              };
            }

            const contentType = response.headers.get("content-type") || "";
            const rawBody = await response.text();

            if (
              contentType.includes("text/html") ||
              contentType.includes("application/xhtml")
            ) {
              body = htmlToText(rawBody);
            } else {
              // Plain text, markdown, etc. — use as-is
              body = rawBody;
            }
          } catch (fetchErr: any) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error fetching URL: ${fetchErr.message}`,
                },
              ],
              isError: true,
            };
          }
        } else {
          body = content!;
        }

        const frontmatter = [
          "---",
          `title: "${title.replace(/"/g, '\\"')}"`,
          sourceUrl ? `source: "${sourceUrl}"` : "",
          `date_created: ${TODAY()}`,
          `type: article`,
          `status: raw`,
          `tags: [raw]`,
          "---",
        ]
          .filter(Boolean)
          .join("\n");

        const fullContent = `${frontmatter}\n\n# ${title}\n\n${body}`;

        await writeVaultFile(backend, filePath, fullContent);

        const wordCount = body.split(/\s+/).length;

        const responseText = [
          `Saved to: ${filePath}`,
          `Words: ~${wordCount}`,
          sourceUrl ? `Source: ${sourceUrl}` : "Source: direct input",
          "",
          '**Next:** Run `synapse_ingest({ sourcePath: "' +
            filePath +
            '" })` to process this into the wiki.',
        ].join("\n");

        return {
          content: [
            {
              type: "text",
              text: config ? responseText : responseText + SETUP_TIP,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error saving content: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── synapse_status ──────────────────────────────────────────────────
  server.tool(
    "synapse_status",
    `One-shot status overview. Returns everything needed to understand the vault state: configuration, file counts, recent activity, CLAUDE.md schema, and suggested next actions. This is THE tool to call when a user first connects or asks "what can you do?"`,
    {},
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async () => {
      try {
        const config = await loadConfig(backend);

        const hasClaudeMd = await backend.exists("CLAUDE.md");

        // Use config-aware paths for file counting
        const sourcesFolder = config?.sourcesFolder || "sources";
        const notesFolder = config?.wikiFolder || "notes";

        // File counts
        const allFiles = await listVaultFiles(backend);
        const rawFiles = await listVaultFiles(backend, sourcesFolder);
        const notesFiles = (await backend.exists(notesFolder))
          ? await listVaultFiles(backend, notesFolder)
          : [];

        // Count unprocessed sources by comparing against notes
        const notesBasenames = new Set(
          notesFiles.map((f) => path.basename(f, ".md").toLowerCase()),
        );
        let unprocessedCount = 0;
        for (const rawFile of rawFiles) {
          const basename = path.basename(rawFile, ".md").toLowerCase();
          const isProcessed = [...notesBasenames].some(
            (s) => s.includes(basename) || basename.includes(s),
          );
          if (!isProcessed) unprocessedCount++;
        }

        // Recent activity from log
        const logPath = config?.wikiFolder
          ? `${config.wikiFolder}/log.md`
          : "log.md";
        let recentLog = "(No log yet)";
        if (await backend.exists(logPath)) {
          const logContent = await readVaultFile(backend, logPath);
          const logLines = logContent
            .split("\n")
            .filter((l) => l.startsWith("## ["));
          recentLog =
            logLines.length > 0
              ? logLines.slice(-5).reverse().join("\n")
              : "(No entries yet)";
        }

        // CLAUDE.md schema
        let schema = "";
        const schemaPath = config?.schemaPath || "CLAUDE.md";
        if (await backend.exists(schemaPath)) {
          schema = await readVaultFile(backend, schemaPath);
        }

        const output: string[] = ["## Synapse Knowledge Base Status", ""];

        // Config section
        if (config) {
          output.push(
            `**Mode:** ${config.mode}`,
            `**Purpose:** ${config.purpose || "not set"}${config.purposeDescription ? ` — ${config.purposeDescription}` : ""}`,
            `**Sources folder:** ${config.sourcesFolder}`,
            `**Outputs folder:** ${config.outputsFolder}`,
            `**Notes folder:** ${config.wikiFolder || "(vault root)"}`,
            config.topic ? `**Topic:** ${config.topic}` : "",
            `**Configured:** ${config.configuredAt || "unknown"}`,
            "",
          );
        } else {
          output.push(
            "**Synapse hasn't been configured yet.** Run `synapse_setup` to get started.",
            "",
          );
        }

        // Check initialization based on mode
        const hasSourcesDir = await backend.exists(sourcesFolder);
        const hasNotesDir = await backend.exists(notesFolder);
        const initialized = config
          ? true
          : hasSourcesDir && hasNotesDir && hasClaudeMd;

        output.push(
          `**Total vault files:** ${allFiles.length}`,
          `**Sources:** ${rawFiles.length}`,
          `**Notes:** ${notesFiles.length}`,
          `**Unprocessed sources:** ${unprocessedCount}`,
          "",
        );

        if (recentLog !== "(No log yet)") {
          output.push("### Recent Activity");
          output.push(recentLog);
          output.push("");
        }

        // Build suggested actions
        const actions: string[] = [];
        if (!config) {
          actions.push(
            "1. **Set up Synapse:** Run `synapse_setup` to configure Synapse for your vault.",
          );
        }
        if (rawFiles.length === 0) {
          const saveFolder = config?.sourcesFolder || "sources";
          actions.push(
            `1. **Add sources:** Save articles with \`synapse_save\` (paste text or provide a URL), or add markdown files to \`${saveFolder}\`.`,
          );
        }
        if (unprocessedCount > 0) {
          actions.push(
            `1. **Process sources:** ${unprocessedCount} unprocessed source${unprocessedCount > 1 ? "s" : ""} ready. Run \`synapse_compile\` to see them, then \`synapse_ingest\` each one.`,
          );
        }
        if (initialized && rawFiles.length > 0 && notesFiles.length <= 3) {
          actions.push(
            "2. **Build the wiki:** Run `synapse_compile` to process sources into organized pages.",
          );
        }
        if (initialized && notesFiles.length > 5) {
          actions.push(
            "3. **Query:** Ask questions with `synapse_query` to research your knowledge base.",
          );
          actions.push(
            "4. **Health check:** Run `synapse_lint` to check for broken links, orphan pages, and stale content.",
          );
        }

        if (actions.length > 0) {
          output.push("### Suggested Next Actions");
          output.push(...actions);
          output.push("");
        }

        if (schema) {
          output.push("### Wiki Schema (CLAUDE.md)");
          output.push("```markdown");
          output.push(schema.slice(0, 4000));
          if (schema.length > 4000) output.push("... (truncated)");
          output.push("```");
          output.push("");
        }

        output.push("### How to Use Synapse");
        output.push("");
        output.push(
          "Synapse turns your Obsidian vault into an AI-powered knowledge base. The workflow:",
        );
        output.push("");
        output.push(
          "1. **Save** sources with `synapse_save` (URL or pasted text) or add files to your sources folder",
        );
        output.push(
          "2. **Process** them with `synapse_compile` + `synapse_ingest` to build organized pages",
        );
        output.push(
          "3. **Query** your knowledge with `synapse_query` — get answers with citations",
        );
        output.push(
          "4. **Maintain** quality with `synapse_lint` — finds broken links, orphans, stale content",
        );
        output.push("");
        output.push(
          "**Available tools:** synapse_setup, synapse_configure, synapse_save, synapse_status, synapse_compile, synapse_ingest, synapse_query, synapse_lint, vault_read, vault_write, vault_list, vault_search, vault_stats, vault_frontmatter",
        );

        return { content: [{ type: "text", text: output.join("\n") }] };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting status: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── synapse_ingest ──────────────────────────────────────────────────
  server.tool(
    "synapse_ingest",
    `Process a source file into the knowledge base. Reads the source, generates organized pages (summaries, concepts, entities), adds [[wikilinks]], and updates the index and log.

You MUST read the source file content first, then generate all pages. Follow the CLAUDE.md schema in the vault root for conventions and folder paths.

Steps:
1. Read the source file
2. Create a summary page in the configured notes folder
3. For each key concept: create/update a concept page
4. For each key entity: create/update an entity page
5. Add [[wikilinks]] connecting related pages
6. Update the index
7. Append to the log`,
    {
      sourcePath: z
        .string()
        .describe(
          "Path to the source file relative to vault (e.g. 'sources/my-article.md')",
        ),
    },
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ sourcePath }) => {
      try {
        const config = await loadConfig(backend);
        const notesFolder = config?.wikiFolder || "notes";
        const schemaPath = config?.schemaPath || "CLAUDE.md";

        const content = await readVaultFile(backend, sourcePath);
        const fm = parseFrontmatter(content);

        const existingNotes = (await backend.exists(notesFolder))
          ? await listVaultFiles(backend, notesFolder)
          : [];
        const sourceBasename = path.basename(sourcePath, ".md");

        const alreadyProcessed = existingNotes.some((f) =>
          f.includes(sourceBasename),
        );

        let existingIndex = "";
        if (await backend.exists("index.md")) {
          existingIndex = await readVaultFile(backend, "index.md");
        }

        let schema = "";
        if (await backend.exists(schemaPath)) {
          schema = await readVaultFile(backend, schemaPath);
        }

        const output = [
          "## Ingest Task Ready",
          "",
          `**Source:** ${sourcePath}`,
          `**Already processed:** ${alreadyProcessed ? "YES — update existing pages" : "NO — create new pages"}`,
          "",
          "### Source Content",
          "```markdown",
          content.slice(0, 15000),
          content.length > 15000 ? "\n... (truncated)" : "",
          "```",
          "",
          "### Source Frontmatter",
          JSON.stringify(fm, null, 2),
          "",
          "### Current Index",
          existingIndex
            ? "```markdown\n" + existingIndex.slice(0, 5000) + "\n```"
            : "(No index yet — this is the first ingest)",
          "",
          schema
            ? "### Schema (CLAUDE.md)\n```markdown\n" +
              schema.slice(0, 3000) +
              "\n```"
            : "",
          "",
          "### Instructions",
          "",
          "Read the CLAUDE.md schema above for folder paths and conventions. Use `vault_write` to create/update:",
          `1. A summary page in \`${notesFolder}/\` — 200-500 word summary with frontmatter`,
          `2. Concept pages in \`${notesFolder}/\` — for each key concept (create if 2+ mentions, stub if 1). Create sub-folders if needed.`,
          `3. Entity pages in \`${notesFolder}/\` — for people, orgs, tools mentioned`,
          `4. \`index.md\` — updated master index with new entries`,
          "",
          "Use [[wikilinks]] for all cross-references.",
          "Follow the file naming and frontmatter conventions from CLAUDE.md.",
        ];

        if (!config) {
          output.push("", SETUP_TIP);
        }

        return {
          content: [{ type: "text", text: output.join("\n") }],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error preparing ingest: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "synapse_compile",
    `Scan for all unprocessed sources and compile them into organized pages. Lists which sources exist in the sources folder but don't have corresponding summaries yet. Use synapse_ingest on each one to process them.`,
    {},
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async () => {
      try {
        const config = await loadConfig(backend);
        const sourcesFolder = config?.sourcesFolder || "sources";
        const notesFolder = config?.wikiFolder || "notes";

        const rawFiles = await listVaultFiles(backend, sourcesFolder);
        const notesFiles = (await backend.exists(notesFolder))
          ? await listVaultFiles(backend, notesFolder)
          : [];

        if (rawFiles.length === 0) {
          const tipSuffix = config ? "" : SETUP_TIP;
          return {
            content: [
              {
                type: "text",
                text: `No files found in ${sourcesFolder}/. Add source articles to \`${sourcesFolder}\` first.${tipSuffix}`,
              },
            ],
          };
        }

        const notesBasenames = new Set(
          notesFiles.map((f) => path.basename(f, ".md").toLowerCase()),
        );

        const unprocessed: string[] = [];
        const processed: string[] = [];

        for (const rawFile of rawFiles) {
          const basename = path.basename(rawFile, ".md").toLowerCase();
          const isProcessed = [...notesBasenames].some(
            (s) => s.includes(basename) || basename.includes(s),
          );
          if (isProcessed) {
            processed.push(rawFile);
          } else {
            unprocessed.push(rawFile);
          }
        }

        const output = [
          `## Compilation Status`,
          "",
          `**Raw sources:** ${rawFiles.length}`,
          `**Already processed:** ${processed.length}`,
          `**Needs processing:** ${unprocessed.length}`,
          "",
        ];

        if (unprocessed.length > 0) {
          output.push("### Unprocessed Sources");
          output.push("Call `synapse_ingest` for each of these:\n");
          for (const f of unprocessed) {
            output.push(`- ${f}`);
          }
          output.push("");
          output.push(
            `Start with: synapse_ingest({ sourcePath: "${unprocessed[0]}" })`,
          );
        } else {
          output.push("All sources have been processed. Wiki is up to date.");
        }

        return {
          content: [{ type: "text", text: output.join("\n") }],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error scanning for compilation: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "synapse_query",
    `Research a question against the knowledge base. Reads the index, identifies relevant pages, and returns their content so you can synthesize an answer. You MUST save the synthesized answer to the outputs folder using vault_write after responding.`,
    {
      question: z.string().describe("The question to research"),
      save: z
        .boolean()
        .optional()
        .describe(
          "Whether to save the answer to the outputs folder (default: true). Set false for quick lookups.",
        ),
    },
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ question, save }) => {
      try {
        const config = await loadConfig(backend);
        const notesFolder = config?.wikiFolder || "notes";
        const outputsFolder = config?.outputsFolder || "outputs";

        const shouldSave = save !== false;
        const outputSlug = slugify(question);
        const outputPath = `${outputsFolder}/${outputSlug}.md`;

        let index = "";
        if (await backend.exists("index.md")) {
          index = await readVaultFile(backend, "index.md");
        }

        const keywords = question
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 3);

        const allResults: Map<string, string> = new Map();

        // Search notes folder if it exists, otherwise search whole vault
        const searchPath = (await backend.exists(notesFolder))
          ? notesFolder
          : undefined;

        for (const keyword of keywords.slice(0, 5)) {
          const results = await searchVault(backend, keyword, {
            subPath: searchPath,
            maxResults: 10,
          });
          for (const r of results) {
            if (!allResults.has(r.file)) {
              allResults.set(r.file, r.title);
            }
          }
        }

        const relevantFiles = [...allResults.entries()].slice(0, 10);
        const pageContents: string[] = [];

        for (const [file] of relevantFiles) {
          try {
            const content = await readVaultFile(backend, file);
            pageContents.push(
              `### ${file}\n\`\`\`markdown\n${content.slice(0, 3000)}\n\`\`\``,
            );
          } catch {
            // Skip unreadable files
          }
        }

        const output = [
          `## Query: ${question}`,
          "",
          "### Index",
          index
            ? "```markdown\n" + index.slice(0, 5000) + "\n```"
            : "(No index found — run synapse_compile first)",
          "",
          `### Relevant Pages (${relevantFiles.length} found)`,
          "",
          ...pageContents,
          "",
          "### Instructions",
          "",
          "Synthesize an answer to the question using the content above.",
          "- Cite sources using [[wikilinks]]",
          "- If information is insufficient, say what's missing",
        ];

        if (shouldSave) {
          output.push(
            "",
            "### REQUIRED: Save Your Answer",
            "",
            `After synthesizing your answer, you MUST call vault_write with exactly these parameters:`,
            "",
            "```json",
            JSON.stringify(
              {
                path: outputPath,
                content: `---\ntitle: "${question}"\ndate_created: ${TODAY()}\nsummary: "Answer to: ${question}"\ntags: [query, output]\ntype: output\nstatus: final\n---\n\n# ${question}\n\n[YOUR SYNTHESIZED ANSWER HERE — use [[wikilinks]] for citations]`,
              },
              null,
              2,
            ),
            "```",
            "",
            `Then update index.md (add entry under Outputs).`,
          );
        }

        if (!config) {
          output.push("", SETUP_TIP);
        }

        return { content: [{ type: "text", text: output.join("\n") }] };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error researching query: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "synapse_lint",
    `Health-check the knowledge base. Scans for contradictions, orphan pages, broken wikilinks, missing frontmatter, stale content, and missing pages. Returns a report and instructions for fixing issues.`,
    {},
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async () => {
      try {
        const config = await loadConfig(backend);
        const notesFolder = config?.wikiFolder || "notes";
        const outputsFolder = config?.outputsFolder || "outputs";

        // If notes folder exists scan it, otherwise scan the whole vault
        const scanPath = (await backend.exists(notesFolder))
          ? notesFolder
          : undefined;
        const scannedFiles = scanPath
          ? await listVaultFiles(backend, scanPath)
          : await listVaultFiles(backend);

        if (scannedFiles.length === 0) {
          const tipSuffix = config ? "" : SETUP_TIP;
          return {
            content: [
              {
                type: "text",
                text: `No files found to check. Run synapse_setup to configure Synapse first.${tipSuffix}`,
              },
            ],
          };
        }

        const allLinks = new Set<string>();
        const allPages = new Set<string>();
        const orphans: string[] = [];
        const missingFm: string[] = [];
        const stalePages: string[] = [];
        const brokenLinks: string[] = [];

        const inboundLinks = new Map<string, number>();

        for (const file of scannedFiles) {
          const basename = path.basename(file, ".md");
          allPages.add(basename);
          inboundLinks.set(basename, 0);
        }

        for (const file of scannedFiles) {
          const content = await readVaultFile(backend, file);
          const fm = parseFrontmatter(content);

          if (!fm.title || !fm.type || !fm.date_created) {
            missingFm.push(file);
          }

          if (fm.date_modified || fm.date_created) {
            const date = new Date(fm.date_modified || fm.date_created);
            const sixMonthsAgo = new Date();
            sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
            if (date < sixMonthsAgo) {
              stalePages.push(file);
            }
          }

          const linkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
          let match;
          while ((match = linkRegex.exec(content)) !== null) {
            const linkTarget = match[1].toLowerCase().replace(/\s+/g, "-");
            allLinks.add(linkTarget);

            const current = inboundLinks.get(linkTarget) || 0;
            inboundLinks.set(linkTarget, current + 1);

            if (!allPages.has(linkTarget)) {
              brokenLinks.push(`${file} -> [[${match[1]}]]`);
            }
          }
        }

        for (const file of scannedFiles) {
          const basename = path.basename(file, ".md");
          if (
            basename === "index" ||
            basename === "log" ||
            basename === "_index"
          )
            continue;
          if ((inboundLinks.get(basename) || 0) === 0) {
            orphans.push(file);
          }
        }

        const report = [
          "## Health Check Report",
          `**Date:** ${TODAY()}`,
          `**Total pages:** ${scannedFiles.length}`,
          `**Total wikilinks:** ${allLinks.size}`,
          "",
        ];

        if (brokenLinks.length > 0) {
          report.push(`### Broken Links (${brokenLinks.length})`);
          for (const bl of brokenLinks.slice(0, 20)) {
            report.push(`- ${bl}`);
          }
          report.push("");
        }

        if (orphans.length > 0) {
          report.push(
            `### Orphan Pages — no inbound links (${orphans.length})`,
          );
          for (const o of orphans.slice(0, 20)) {
            report.push(`- ${o}`);
          }
          report.push("");
        }

        if (missingFm.length > 0) {
          report.push(
            `### Missing/Incomplete Frontmatter (${missingFm.length})`,
          );
          for (const m of missingFm.slice(0, 20)) {
            report.push(`- ${m}`);
          }
          report.push("");
        }

        if (stalePages.length > 0) {
          report.push(
            `### Stale Content — >6 months old (${stalePages.length})`,
          );
          for (const s of stalePages.slice(0, 20)) {
            report.push(`- ${s}`);
          }
          report.push("");
        }

        const allClean =
          brokenLinks.length === 0 &&
          orphans.length === 0 &&
          missingFm.length === 0 &&
          stalePages.length === 0;

        if (allClean) {
          report.push("All checks passed. Wiki is healthy.");
        } else {
          report.push("### Suggested Actions");
          if (brokenLinks.length > 0) {
            report.push(
              "- Create stub pages for broken link targets using vault_write",
            );
          }
          if (orphans.length > 0) {
            report.push(
              "- Add [[wikilinks]] to orphan pages from related content",
            );
          }
          if (missingFm.length > 0) {
            report.push(
              "- Add frontmatter (title, type, date_created, summary) to pages missing it",
            );
          }
          if (stalePages.length > 0) {
            report.push("- Review stale pages and update or mark as archived");
          }
          report.push("");
          report.push(
            `Save this report using vault_write to: ${outputsFolder}/lint-report-${TODAY()}.md`,
          );
        }

        if (!config) {
          report.push("", SETUP_TIP);
        }

        return {
          content: [{ type: "text", text: report.join("\n") }],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error running lint: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}
