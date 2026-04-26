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
import { fetchUrlAsText } from "../utils/fetch.js";
import { getFilingHintCached } from "../utils/cache.js";

const TODAY = () => new Date().toISOString().split("T")[0];

const SETUP_TIP =
  "\n\n> **Tip:** Run `taproot_plant` to configure Taproot for your vault.";

export function registerKnowledgeTools(
  server: McpServer,
  backend: StorageBackend,
): void {
  // ── taproot_seed ────────────────────────────────────────────────────
  server.registerTool(
    "taproot_seed",
    {
      title: "Save a source",
      description: `FALLBACK / multi-step entry. Use this only for: (a) saving pasted text content (no URL), or (b) the legacy seed → water → cultivate chain when the user explicitly wants the full processing pipeline. For the common case of "save this URL/article" — prefer \`taproot_save_url\` (single call: fetch + extract + save). Triggers for THIS tool: 'save this raw text to my sources', 'add this pasted content as a source', 'seed this for later processing'. Always writes to the configured sources folder with frontmatter.`,
      inputSchema: {
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
          .describe(
            "Where to save, relative to vault root (default: 'sources')",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
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
            const fetched = await fetchUrlAsText(url);
            body = fetched.body;
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
          '**Next:** Run `taproot_water({ sourcePath: "' +
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

  // ── taproot_status ──────────────────────────────────────────────────
  server.registerTool(
    "taproot_status",
    {
      title: "Garden status",
      description: `Use this whenever the user first connects, asks what's set up, what's pending, or what they should do next. Returns config, file counts, unprocessed source count, recent activity, the CLAUDE.md schema, and suggested next actions in one call. Triggers: 'what can you do', 'what's set up', 'what's pending', 'how do I use this', 'where do I start', 'is this connected'. This is THE first call when a user is exploring or onboarding.`,
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

        const output: string[] = ["## Taproot Knowledge Base Status", ""];

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
            "**Taproot hasn't been configured yet.** Run `taproot_plant` to get started.",
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
            "1. **Set up Taproot:** Run `taproot_plant` to configure Taproot for your vault.",
          );
        }
        if (rawFiles.length === 0) {
          const saveFolder = config?.sourcesFolder || "sources";
          actions.push(
            `1. **Add sources:** Save articles with \`taproot_seed\` (paste text or provide a URL), or add markdown files to \`${saveFolder}\`.`,
          );
        }
        if (unprocessedCount > 0) {
          actions.push(
            `1. **Process sources:** ${unprocessedCount} unprocessed source${unprocessedCount > 1 ? "s" : ""} ready. Run \`taproot_cultivate\` to see them, then \`taproot_water\` each one.`,
          );
        }
        if (initialized && rawFiles.length > 0 && notesFiles.length <= 3) {
          actions.push(
            "2. **Build the wiki:** Run `taproot_cultivate` to process sources into organized pages.",
          );
        }
        if (initialized && notesFiles.length > 5) {
          actions.push(
            "3. **Query:** Ask questions with `taproot_harvest` to research your knowledge base.",
          );
          actions.push(
            "4. **Health check:** Run `taproot_prune` to check for broken links, orphan pages, and stale content.",
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

        output.push("### How to Use Taproot");
        output.push("");
        output.push(
          "Taproot turns your Obsidian vault into an AI-powered knowledge base. The workflow:",
        );
        output.push("");
        output.push(
          "1. **Save** sources with `taproot_seed` (URL or pasted text) or add files to your sources folder",
        );
        output.push(
          "2. **Process** them with `taproot_cultivate` + `taproot_water` to build organized pages",
        );
        output.push(
          "3. **Query** your knowledge with `taproot_harvest` — get answers with citations",
        );
        output.push(
          "4. **Maintain** quality with `taproot_prune` — finds broken links, orphans, stale content",
        );
        output.push("");
        output.push(
          "**Available tools:** taproot_plant, taproot_till, taproot_seed, taproot_status, taproot_cultivate, taproot_water, taproot_harvest, taproot_prune, garden_read, garden_plant, garden_survey, garden_forage, garden_measure, garden_tag",
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

  // ── taproot_water ───────────────────────────────────────────────────
  server.registerTool(
    "taproot_water",
    {
      title: "Process a source (chain)",
      description: `FALLBACK for the multi-step ingestion pipeline. Use only when the user explicitly wants to re-process or deeply ingest an EXISTING source file at a known path into structured concept/entity pages with wikilinks. For "save this URL" — prefer \`taproot_save_url\` (single call). For "save this pasted text" — use \`taproot_seed\`. Triggers ONLY when: 'process this source file', 'ingest this into the wiki', 'turn this article into structured notes', 're-water X'. The tool returns instructions; you (the caller) must then read the source and create pages with \`garden_plant\` per the CLAUDE.md schema.`,
      inputSchema: {
        sourcePath: z
          .string()
          .describe(
            "Path to the source file relative to vault (e.g. 'sources/my-article.md')",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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
          "Read the CLAUDE.md schema above for folder paths and conventions. Use `garden_plant` to create/update:",
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

  server.registerTool(
    "taproot_cultivate",
    {
      title: "Find unprocessed sources",
      description: `Use this whenever the user wants to know which raw sources still need processing into the wiki. Compares the sources folder against the notes folder and lists the gap. Triggers: 'what hasn't been processed', 'show me unprocessed sources', 'what's left to ingest', 'what's still raw', 'what should I water next'. After getting the list, call \`taproot_water\` on each unprocessed file.`,
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
          output.push("Call `taproot_water` for each of these:\n");
          for (const f of unprocessed) {
            output.push(`- ${f}`);
          }
          output.push("");
          output.push(
            `Start with: taproot_water({ sourcePath: "${unprocessed[0]}" })`,
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

  server.registerTool(
    "taproot_harvest",
    {
      title: "Research a question",
      description: `Use this whenever the user wants a synthesized answer drawn from MULTIPLE notes across their vault — a research-style question that needs cross-referencing, citation, and saving the result. Reads the index, locates relevant pages, returns their content so you can synthesize an answer with [[wikilink]] citations. Triggers: 'what does my brain say about X', 'research X across my notes', 'compare what I have on X vs Y', 'deep dive on X', 'summarize everything I know about X'. For looking up a single specific note, prefer \`garden_find\` + \`garden_read\`. For a phrase search, use \`garden_forage\`.`,
      inputSchema: {
        question: z.string().describe("The question to research"),
        save: z
          .boolean()
          .optional()
          .describe(
            "Whether to save the answer to the outputs folder (default: true). Set false for quick lookups.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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
            : "(No index found — run taproot_cultivate first)",
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
            `After synthesizing your answer, you MUST call garden_plant with exactly these parameters:`,
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

  server.registerTool(
    "taproot_prune",
    {
      title: "Health check",
      description: `Use this whenever the user wants a quality audit of their vault — broken links, orphan pages, missing frontmatter, stale content. Returns a report and suggested fixes. Triggers: 'lint my vault', 'health check', 'find broken links', 'find orphan notes', 'audit my brain', 'what's broken', 'is anything stale'. After reviewing the report, you can fix issues with \`garden_plant\`.`,
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
                text: `No files found to check. Run taproot_plant to configure Taproot first.${tipSuffix}`,
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
              "- Create stub pages for broken link targets using garden_plant",
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
            `Save this report using garden_plant to: ${outputsFolder}/lint-report-${TODAY()}.md`,
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

  // ── taproot_save_url ────────────────────────────────────────────────
  server.registerTool(
    "taproot_save_url",
    {
      title: "Save a URL",
      description: `Use this whenever the user wants to save a URL, article, blog post, web page, or link to their vault. Single call: fetches the URL, extracts text, files it under the configured sources folder (or a folder you suggest) with frontmatter. PREFER this over the \`taproot_seed\` → \`taproot_water\` chain for any URL save. Triggers: 'save this article', 'save this URL', 'add this link to my notes', 'archive this', 'remember this page', plus any URL the user shares with intent to keep. Use \`preview_only: true\` first if you want to confirm filing/title before committing.`,
      inputSchema: {
        url: z.string().describe("The URL to fetch and save"),
        title: z
          .string()
          .optional()
          .describe(
            "Optional title override. If omitted, uses the page's <title> or a slug of the URL.",
          ),
        suggestedFolder: z
          .string()
          .optional()
          .describe(
            "Optional folder override (relative to vault root). Defaults to the configured sources folder.",
          ),
        suggestedTags: z
          .array(z.string())
          .optional()
          .describe(
            "Optional tags to add to frontmatter (in addition to 'raw')",
          ),
        userIntent: z
          .string()
          .optional()
          .describe(
            "Optional one-liner about why the user is saving this — saved as a 'note' field in frontmatter for future context",
          ),
        previewOnly: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If true, return what WOULD be saved (path, title, excerpt) without writing. Default: false.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      url,
      title,
      suggestedFolder,
      suggestedTags,
      userIntent,
      previewOnly,
    }) => {
      try {
        let fetched;
        try {
          fetched = await fetchUrlAsText(url);
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

        const config = await loadConfig(backend);
        const defaults = getDefaultConfig();
        const targetFolder =
          suggestedFolder || config?.sourcesFolder || defaults.sourcesFolder;

        const resolvedTitle =
          title || fetched.title || urlToSlugTitle(url) || "Saved page";
        const filename = slugify(resolvedTitle) + ".md";
        const filePath = `${targetFolder}/${filename}`;

        const wordCount = fetched.body.split(/\s+/).filter(Boolean).length;
        const excerpt = fetched.body.slice(0, 400);

        if (previewOnly) {
          return {
            content: [
              {
                type: "text",
                text: [
                  "## Preview (not saved)",
                  "",
                  `**Would save to:** ${filePath}`,
                  `**Title:** ${resolvedTitle}`,
                  `**Source:** ${url}`,
                  `**Word count:** ~${wordCount}`,
                  suggestedTags && suggestedTags.length > 0
                    ? `**Tags:** ${["raw", ...suggestedTags].join(", ")}`
                    : "**Tags:** raw",
                  userIntent ? `**Intent:** ${userIntent}` : "",
                  "",
                  "### Excerpt",
                  "```",
                  excerpt,
                  fetched.body.length > 400 ? "..." : "",
                  "```",
                  "",
                  "Re-call without `previewOnly` to commit, or pass `title`/`suggestedFolder`/`suggestedTags` to override.",
                ]
                  .filter(Boolean)
                  .join("\n"),
              },
            ],
          };
        }

        const allTags = ["raw", ...(suggestedTags || [])];
        const frontmatter = [
          "---",
          `title: "${resolvedTitle.replace(/"/g, '\\"')}"`,
          `source: "${url}"`,
          `date_created: ${TODAY()}`,
          `type: article`,
          `status: raw`,
          `tags: [${allTags.join(", ")}]`,
          userIntent ? `note: "${userIntent.replace(/"/g, '\\"')}"` : "",
          "---",
        ]
          .filter(Boolean)
          .join("\n");

        const fullContent = `${frontmatter}\n\n# ${resolvedTitle}\n\n${fetched.body}`;

        await writeVaultFile(backend, filePath, fullContent);

        const filingHint = await getFilingHintCached(backend, filePath);

        const responseText = [
          `Saved: ${filePath}`,
          `Title: ${resolvedTitle}`,
          `Source: ${url}`,
          `Words: ~${wordCount}`,
          filingHint ? `\n${filingHint}` : "",
          config ? "" : SETUP_TIP,
        ]
          .filter(Boolean)
          .join("\n");

        return {
          content: [{ type: "text", text: responseText }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error saving URL: ${err.message}` }],
          isError: true,
        };
      }
    },
  );
}

function urlToSlugTitle(url: string): string | null {
  try {
    const u = new URL(url);
    const lastSegment =
      u.pathname.split("/").filter(Boolean).pop() || u.hostname;
    return decodeURIComponent(lastSegment.replace(/[-_]+/g, " "));
  } catch {
    return null;
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}
