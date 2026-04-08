import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../utils/storage.js";
import {
  loadConfig,
  saveConfig,
  getDefaultConfig,
  type SynapseConfig,
} from "../utils/config.js";
import { readVaultFile, listVaultFiles } from "../utils/vault.js";

const CLAUDE_MD_TEMPLATE = `# LLM Knowledge Base — Schema

## Overview
Personal knowledge base on {TOPIC}. Raw sources live in raw/. The compiled wiki lives in wiki/. You (the AI) maintain all wiki content. I direct strategy; you execute compilation, maintenance, and queries.

## Directory Structure
- raw/ — Source material (read-only for you, I add files here)
- wiki/index.md — Master index linking every page with a one-line summary
- wiki/log.md — Append-only changelog of all operations
- wiki/concepts/ — One article per concept
- wiki/entities/ — People, organisations, tools (one per file)
- wiki/sources/ — One summary per raw source document
- wiki/syntheses/ — Cross-cutting analysis articles
- wiki/outputs/ — Filed answers to my queries

## File Conventions
- All filenames: kebab-case, lowercase (e.g., active-inference.md)
- Source summaries: {author}-{year}-{short-title}.md
- Every page MUST have YAML frontmatter at the top:
  ---
  title: "Page Title"
  date_created: YYYY-MM-DD
  date_modified: YYYY-MM-DD
  summary: "One to two sentences describing this page"
  tags: [topic-tag, domain-tag]
  type: concept | entity | source | synthesis | output
  status: draft | review | final
  ---
- Use [[wikilinks]] for all internal cross-references
- Link only the first occurrence of a concept per section
- Bold key terms on first use in each article

## Operations

### INGEST (when new raw sources are added)
1. Read the new source document
2. Create a source summary in wiki/sources/
3. Identify concepts and entities mentioned
4. Create new concept/entity pages if they don't exist yet
5. Update existing pages with new information (append, don't rewrite)
6. Add [[wikilinks]] to connect new content to existing pages
7. Update wiki/index.md with new entries
8. Append to wiki/log.md

### QUERY (when a question is asked)
1. Read wiki/index.md to understand available content
2. Read the relevant wiki pages
3. Synthesise an answer with citations to wiki pages
4. Save the answer as wiki/outputs/{question-slug}.md
5. Update wiki/index.md and wiki/log.md

### LINT (periodic health check)
1. Find contradictions between pages
2. Find orphan pages (no inbound links)
3. Find broken [[wikilinks]]
4. Identify missing frontmatter fields
5. Flag stale content (source date >6 months, no updates)
6. Suggest new articles for frequently mentioned but unlinked concepts
7. Output a report and fix what you can automatically

## Page Creation Threshold
- Create a full concept/entity page when a subject appears in 2+ sources
- For single-mention subjects, create a stub (frontmatter + one-line definition + link back)
- Never leave a [[wikilink]] pointing to nothing — always create at least a stub

## Quality Standards
- Summaries: 200-500 words, synthesise — don't copy
- Concept articles: 500-1500 words with a clear lead section
- Always trace claims to specific source pages
- Flag contradictions with \u26a0\ufe0f, noting both positions
- Prefer recency when sources conflict
`;

const INDEX_TEMPLATE = `---
title: "Wiki Index"
date_modified: {DATE}
total_articles: 0
---

# Wiki Index

## Overview
Knowledge base on {TOPIC}. 0 articles compiled from 0 raw sources.

## Concepts
(No concepts yet — run kb_ingest or kb_compile to process raw sources)

## Entities
(No entities yet)

## Source Summaries
(No sources processed yet)

## Recently Added
(Nothing yet)
`;

const LOG_TEMPLATE = `---
title: "Wiki Log"
date_created: {DATE}
type: log
---

# Wiki Log

## [{DATE}] init | Knowledge base created
- Topic: {TOPIC}
- Structure: raw/, wiki/ (concepts, entities, sources, syntheses, outputs)
- Schema: CLAUDE.md generated
`;

/**
 * Detect vault conventions by sampling markdown files.
 */
async function detectConventions(backend: StorageBackend): Promise<{
  topFolders: string[];
  totalFiles: number;
  hasClaudeMd: boolean;
  claudeMdSummary: string | null;
  usesWikilinks: boolean;
  usesFrontmatter: boolean;
  fileNaming: "kebab-case" | "title-case" | "mixed";
  suggestedSourcesFolder: string;
  suggestedOutputsFolder: string;
}> {
  const allFiles = await listVaultFiles(backend);
  const totalFiles = allFiles.length;

  // Top-level folders
  const folderSet = new Set<string>();
  for (const f of allFiles) {
    const parts = f.split("/");
    if (parts.length > 1) {
      folderSet.add(parts[0]);
    }
  }
  const topFolders = [...folderSet].sort();

  // CLAUDE.md detection
  const hasClaudeMd = await backend.exists("CLAUDE.md");
  let claudeMdSummary: string | null = null;
  if (hasClaudeMd) {
    try {
      const content = await readVaultFile(backend, "CLAUDE.md");
      // Take first 500 chars as summary
      claudeMdSummary =
        content.length > 500 ? content.slice(0, 500) + "..." : content;
    } catch {
      claudeMdSummary = "(Could not read)";
    }
  }

  // Sample up to 10 .md files for convention detection
  const sampleFiles = allFiles.slice(0, 10);
  let wikilinkCount = 0;
  let frontmatterCount = 0;

  for (const file of sampleFiles) {
    try {
      const content = await readVaultFile(backend, file);
      if (/\[\[[^\]]+\]\]/.test(content)) {
        wikilinkCount++;
      }
      if (content.startsWith("---")) {
        frontmatterCount++;
      }
    } catch {
      // skip unreadable files
    }
  }

  const sampled = sampleFiles.length || 1;
  const usesWikilinks = wikilinkCount / sampled >= 0.3;
  const usesFrontmatter = frontmatterCount / sampled >= 0.3;

  // Naming convention detection
  let kebabCount = 0;
  let titleCount = 0;
  for (const file of allFiles.slice(0, 20)) {
    const basename = file.split("/").pop()?.replace(".md", "") || "";
    if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(basename)) {
      kebabCount++;
    } else if (/^[A-Z]/.test(basename) && basename.includes(" ")) {
      titleCount++;
    }
  }
  const fileNaming: "kebab-case" | "title-case" | "mixed" =
    kebabCount > titleCount * 2
      ? "kebab-case"
      : titleCount > kebabCount * 2
        ? "title-case"
        : "mixed";

  // Suggest sources folder
  const sourceFolderCandidates = [
    "inbox",
    "raw",
    "raw/articles",
    "references",
    "sources",
    "clippings",
  ];
  let suggestedSourcesFolder = "raw/articles";
  for (const candidate of sourceFolderCandidates) {
    if (topFolders.includes(candidate.split("/")[0])) {
      suggestedSourcesFolder = candidate;
      break;
    }
  }

  // Suggest outputs folder
  const outputCandidates = ["outputs", "research", "queries"];
  let suggestedOutputsFolder = "outputs";
  for (const candidate of outputCandidates) {
    if (topFolders.includes(candidate)) {
      suggestedOutputsFolder = candidate;
      break;
    }
  }

  return {
    topFolders,
    totalFiles,
    hasClaudeMd,
    claudeMdSummary,
    usesWikilinks,
    usesFrontmatter,
    fileNaming,
    suggestedSourcesFolder,
    suggestedOutputsFolder,
  };
}

/**
 * Run the full Karpathy KB scaffold (same as original kb_init).
 */
async function scaffoldKarpathyKB(
  backend: StorageBackend,
  topic: string,
): Promise<{ created: string[]; skipped: string[] }> {
  const today = new Date().toISOString().split("T")[0];
  const created: string[] = [];
  const skipped: string[] = [];

  // Create directories
  const dirs = [
    "raw/articles",
    "raw/papers",
    "raw/repos",
    "raw/datasets",
    "raw/assets",
    "wiki/concepts",
    "wiki/entities",
    "wiki/sources",
    "wiki/syntheses",
    "wiki/outputs",
    "wiki/attachments/images",
    "templates",
  ];

  for (const dir of dirs) {
    if (!(await backend.exists(dir))) {
      await backend.mkdir(dir);
      created.push(`${dir}/`);
    }
  }

  // Create CLAUDE.md
  if (!(await backend.exists("CLAUDE.md"))) {
    const claudeContent = CLAUDE_MD_TEMPLATE.replace(/\{TOPIC\}/g, topic);
    await backend.writeFile("CLAUDE.md", claudeContent);
    created.push("CLAUDE.md");
  } else {
    skipped.push("CLAUDE.md (already exists)");
  }

  // Create wiki/index.md
  if (!(await backend.exists("wiki/index.md"))) {
    const indexContent = INDEX_TEMPLATE.replace(/\{DATE\}/g, today).replace(
      /\{TOPIC\}/g,
      topic,
    );
    await backend.writeFile("wiki/index.md", indexContent);
    created.push("wiki/index.md");
  } else {
    skipped.push("wiki/index.md (already exists)");
  }

  // Create wiki/log.md
  if (!(await backend.exists("wiki/log.md"))) {
    const logContent = LOG_TEMPLATE.replace(/\{DATE\}/g, today).replace(
      /\{TOPIC\}/g,
      topic,
    );
    await backend.writeFile("wiki/log.md", logContent);
    created.push("wiki/log.md");
  } else {
    skipped.push("wiki/log.md (already exists)");
  }

  // Create _index.md stubs
  const subfolders = [
    "concepts",
    "entities",
    "sources",
    "syntheses",
    "outputs",
  ];
  for (const sub of subfolders) {
    const indexFile = `wiki/${sub}/_index.md`;
    if (!(await backend.exists(indexFile))) {
      await backend.writeFile(
        indexFile,
        [
          "---",
          `title: "${sub.charAt(0).toUpperCase() + sub.slice(1)}"`,
          `date_created: ${today}`,
          `type: index`,
          "---",
          "",
          `# ${sub.charAt(0).toUpperCase() + sub.slice(1)}`,
          "",
          `Category index for ${sub}. Updated automatically.`,
        ].join("\n"),
      );
      created.push(indexFile);
    }
  }

  // Create source template
  if (!(await backend.exists("templates/source-summary.md"))) {
    await backend.writeFile(
      "templates/source-summary.md",
      [
        "---",
        'title: "{{title}}"',
        "date_created: {{date}}",
        "date_modified: {{date}}",
        'summary: ""',
        "tags: []",
        "type: source",
        "status: draft",
        'source_url: ""',
        "authors: []",
        "---",
        "",
        "# {{title}}",
        "",
        "## Summary",
        "",
        "## Key Concepts",
        "",
        "## Notable Quotes",
        "",
        "## Connections",
      ].join("\n"),
    );
    created.push("templates/source-summary.md");
  }

  return { created, skipped };
}

export function registerInitTools(
  server: McpServer,
  backend: StorageBackend,
): void {
  // ── kb_setup ─────────────────────────────────────────────────────────
  server.tool(
    "kb_setup",
    `Onboarding entry point for Synapse. Scans the vault to detect existing structure, conventions, and CLAUDE.md, then returns three configuration options for the user to choose from:
- Option A: Use existing vault conventions (adapts to what's already there)
- Option B: Set up Karpathy Knowledge Base (full raw/wiki structure for a specific topic)
- Option C: Start fresh with custom settings

After the user chooses, call kb_configure with their selection.`,
    {},
    async () => {
      try {
        // Check if already configured
        const existingConfig = await loadConfig(backend);

        const detection = await detectConventions(backend);

        const output: string[] = ["## Synapse Vault Setup", ""];

        if (existingConfig) {
          output.push(
            `> **Note:** Synapse is already configured (mode: ${existingConfig.mode}, configured ${existingConfig.configuredAt || "unknown"}). Running setup again will overwrite the existing config.`,
            "",
          );
        }

        output.push(
          "### Vault Scan Results",
          "",
          `- **Total files:** ${detection.totalFiles}`,
          `- **Top folders:** ${detection.topFolders.length > 0 ? detection.topFolders.join(", ") : "(empty vault)"}`,
          `- **CLAUDE.md:** ${detection.hasClaudeMd ? "Yes" : "No"}`,
          `- **Uses [[wikilinks]]:** ${detection.usesWikilinks ? "Yes" : "No"}`,
          `- **Uses frontmatter:** ${detection.usesFrontmatter ? "Yes" : "No"}`,
          `- **File naming:** ${detection.fileNaming}`,
          "",
        );

        if (detection.hasClaudeMd && detection.claudeMdSummary) {
          output.push(
            "### Detected CLAUDE.md",
            "```",
            detection.claudeMdSummary,
            "```",
            "",
          );
        }

        // Option A
        output.push(
          "---",
          "",
          "### Option A: Use My Existing Vault",
          "",
          "Synapse adapts to your current structure. No folders created, no files moved.",
          "",
          `- Sources saved to: \`${detection.suggestedSourcesFolder}\``,
          `- Outputs saved to: \`${detection.suggestedOutputsFolder}\``,
          `- Wikilinks: ${detection.usesWikilinks ? "enabled (detected)" : "disabled (not detected)"}`,
          `- Frontmatter: ${detection.usesFrontmatter ? "enabled (detected)" : "disabled (not detected)"}`,
          `- File naming: ${detection.fileNaming}`,
          "",
          "To choose this, call:",
          "```",
          `kb_configure({ mode: "existing" })`,
          "```",
          "",
        );

        // Option B
        output.push(
          "### Option B: Set Up Karpathy Knowledge Base",
          "",
          "Creates a full structured wiki: `raw/` for source material, `wiki/` for compiled knowledge, `CLAUDE.md` schema. Best for building a focused knowledge base on a specific topic.",
          "",
          "To choose this, call:",
          "```",
          `kb_configure({ mode: "kb", topic: "your topic here" })`,
          "```",
          "",
        );

        // Option C
        output.push(
          "### Option C: Start Fresh (Custom)",
          "",
          "Tell Synapse exactly how you want your vault organized. Specify your own folder names and conventions.",
          "",
          "To choose this, call:",
          "```",
          `kb_configure({ mode: "custom", sourcesFolder: "...", outputsFolder: "...", fileNaming: "kebab-case" })`,
          "```",
          "",
        );

        output.push(
          "---",
          "",
          "**Ask the user which option they prefer**, then call `kb_configure` with their choice.",
        );

        return {
          content: [{ type: "text", text: output.join("\n") }],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error scanning vault: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── kb_configure ────────────────────────────────────────────────────
  server.tool(
    "kb_configure",
    `Save Synapse configuration based on the user's choice from kb_setup. Three modes:
- "existing": Auto-detect conventions from the vault and save config. No folders created.
- "kb": Run the full Karpathy KB scaffold (creates raw/, wiki/, CLAUDE.md, templates/). Requires a topic.
- "custom": Save whatever folder paths and conventions the user specified.`,
    {
      mode: z
        .enum(["existing", "kb", "custom"])
        .describe("Configuration mode chosen by the user"),
      sourcesFolder: z
        .string()
        .optional()
        .describe(
          "Where to save raw articles (default: auto-detect or 'raw/articles')",
        ),
      wikiFolder: z
        .string()
        .optional()
        .describe(
          "Where compiled wiki content goes (default: 'wiki' for kb mode, null for existing)",
        ),
      outputsFolder: z
        .string()
        .optional()
        .describe(
          "Where to save query outputs (default: auto-detect or 'outputs')",
        ),
      topic: z
        .string()
        .optional()
        .describe("Topic for the knowledge base (required for kb mode)"),
      fileNaming: z
        .enum(["kebab-case", "title-case", "as-is"])
        .optional()
        .describe(
          "File naming convention (default: auto-detect or kebab-case)",
        ),
    },
    async ({
      mode,
      sourcesFolder,
      wikiFolder,
      outputsFolder,
      topic,
      fileNaming,
    }) => {
      try {
        const config: SynapseConfig = getDefaultConfig();
        config.mode = mode;
        config.configuredAt = new Date().toISOString();

        if (mode === "existing") {
          // Auto-detect conventions
          const detection = await detectConventions(backend);
          config.sourcesFolder =
            sourcesFolder || detection.suggestedSourcesFolder;
          config.wikiFolder = wikiFolder || null;
          config.outputsFolder =
            outputsFolder || detection.suggestedOutputsFolder;
          config.fileNaming =
            fileNaming ||
            (detection.fileNaming === "mixed" ? "as-is" : detection.fileNaming);
          config.useFrontmatter = detection.usesFrontmatter;
          config.useWikilinks = detection.usesWikilinks;
          config.schemaPath = detection.hasClaudeMd ? "CLAUDE.md" : null;
          config.topic = topic || null;

          await saveConfig(backend, config);

          return {
            content: [
              {
                type: "text",
                text: [
                  "## Synapse Configured (Existing Vault Mode)",
                  "",
                  `- **Sources folder:** ${config.sourcesFolder}`,
                  `- **Outputs folder:** ${config.outputsFolder}`,
                  `- **Wiki folder:** ${config.wikiFolder || "(none — using vault root)"}`,
                  `- **File naming:** ${config.fileNaming}`,
                  `- **Frontmatter:** ${config.useFrontmatter ? "enabled" : "disabled"}`,
                  `- **Wikilinks:** ${config.useWikilinks ? "enabled" : "disabled"}`,
                  `- **CLAUDE.md:** ${config.schemaPath || "none"}`,
                  "",
                  "Config saved to `.synapse/config.json`. All tools will now use these settings.",
                  "",
                  "### Next Steps",
                  `1. Save articles with \`kb_save\` — they'll go to \`${config.sourcesFolder}\``,
                  "2. Use `kb_status` to see your vault overview",
                  "3. Use `kb_query` to research your existing notes",
                ].join("\n"),
              },
            ],
          };
        }

        if (mode === "kb") {
          if (!topic) {
            return {
              content: [
                {
                  type: "text",
                  text: 'Error: KB mode requires a `topic` parameter (e.g. "machine learning", "DeFi protocols").',
                },
              ],
              isError: true,
            };
          }

          // Run the full scaffold
          const { created, skipped } = await scaffoldKarpathyKB(backend, topic);

          config.sourcesFolder = sourcesFolder || "raw/articles";
          config.wikiFolder = wikiFolder || "wiki";
          config.outputsFolder = outputsFolder || "wiki/outputs";
          config.fileNaming = fileNaming || "kebab-case";
          config.useFrontmatter = true;
          config.useWikilinks = true;
          config.schemaPath = "CLAUDE.md";
          config.topic = topic;

          await saveConfig(backend, config);

          const output = [
            "## Knowledge Base Initialized & Configured",
            "",
            `**Topic:** ${topic}`,
            `**Mode:** Karpathy Knowledge Base`,
            "",
            `### Created (${created.length})`,
            ...created.map((f) => `- ${f}`),
            "",
          ];

          if (skipped.length > 0) {
            output.push(`### Skipped (${skipped.length})`);
            output.push(...skipped.map((f) => `- ${f}`));
            output.push("");
          }

          output.push(
            "Config saved to `.synapse/config.json`.",
            "",
            "### Next Steps",
            "1. Add source articles to `raw/articles/` (copy-paste or use `kb_save` with a URL)",
            "2. Run `kb_compile` to see what needs processing",
            "3. Run `kb_ingest` for each source to build the wiki",
            "4. Ask questions with `kb_query`",
            "5. Run `kb_lint` periodically to maintain quality",
          );

          return {
            content: [{ type: "text", text: output.join("\n") }],
          };
        }

        // Custom mode
        config.sourcesFolder = sourcesFolder || "raw/articles";
        config.wikiFolder = wikiFolder || null;
        config.outputsFolder = outputsFolder || "outputs";
        config.fileNaming = fileNaming || "kebab-case";
        config.useFrontmatter = true;
        config.useWikilinks = true;
        config.schemaPath = (await backend.exists("CLAUDE.md"))
          ? "CLAUDE.md"
          : null;
        config.topic = topic || null;

        // Create the source and output directories if they don't exist
        if (!(await backend.exists(config.sourcesFolder))) {
          await backend.mkdir(config.sourcesFolder);
        }
        if (!(await backend.exists(config.outputsFolder))) {
          await backend.mkdir(config.outputsFolder);
        }
        if (config.wikiFolder && !(await backend.exists(config.wikiFolder))) {
          await backend.mkdir(config.wikiFolder);
        }

        await saveConfig(backend, config);

        return {
          content: [
            {
              type: "text",
              text: [
                "## Synapse Configured (Custom Mode)",
                "",
                `- **Sources folder:** ${config.sourcesFolder}`,
                `- **Outputs folder:** ${config.outputsFolder}`,
                `- **Wiki folder:** ${config.wikiFolder || "(none)"}`,
                `- **File naming:** ${config.fileNaming}`,
                `- **Frontmatter:** ${config.useFrontmatter ? "enabled" : "disabled"}`,
                `- **Wikilinks:** ${config.useWikilinks ? "enabled" : "disabled"}`,
                "",
                "Config saved to `.synapse/config.json`. All tools will now use these settings.",
                "",
                "### Next Steps",
                `1. Save articles with \`kb_save\` — they'll go to \`${config.sourcesFolder}\``,
                "2. Use `kb_status` to see your vault overview",
                "3. Use `kb_query` to research your notes",
              ].join("\n"),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error configuring Synapse: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── kb_init (kept as alias, points users to kb_setup) ────────────────
  server.tool(
    "kb_init",
    `Initialize the Karpathy knowledge base structure in the vault. Creates the full folder structure (raw/, wiki/, templates/), generates CLAUDE.md with the wiki schema, and creates the initial index and log files. Safe to run on an existing vault — won't overwrite existing files.

**For new vaults only.** If you have an existing vault, use \`kb_setup\` instead — it detects your conventions and adapts.`,
    {
      topic: z
        .string()
        .describe(
          "The topic or domain for this knowledge base (e.g. 'DeFi protocols', 'machine learning', 'competitive intelligence')",
        ),
    },
    async ({ topic }) => {
      try {
        const { created, skipped } = await scaffoldKarpathyKB(backend, topic);

        // Also save config automatically
        const config: SynapseConfig = getDefaultConfig();
        config.mode = "kb";
        config.sourcesFolder = "raw/articles";
        config.wikiFolder = "wiki";
        config.outputsFolder = "wiki/outputs";
        config.fileNaming = "kebab-case";
        config.useFrontmatter = true;
        config.useWikilinks = true;
        config.schemaPath = "CLAUDE.md";
        config.topic = topic;
        config.configuredAt = new Date().toISOString();
        await saveConfig(backend, config);

        const output = [
          `## Knowledge Base Initialized`,
          "",
          `**Topic:** ${topic}`,
          "",
          `### Created (${created.length})`,
          ...created.map((f) => `- ${f}`),
          "",
        ];

        if (skipped.length > 0) {
          output.push(`### Skipped (${skipped.length})`);
          output.push(...skipped.map((f) => `- ${f}`));
          output.push("");
        }

        output.push(
          "Config saved to `.synapse/config.json`.",
          "",
          "### Next Steps",
          "1. Add source articles to `raw/articles/` (copy-paste or use Obsidian Web Clipper)",
          "2. Run `kb_compile` to see what needs processing",
          "3. Run `kb_ingest` for each source to build the wiki",
          "4. Ask questions with `kb_query`",
          "5. Run `kb_lint` periodically to maintain quality",
        );

        return {
          content: [{ type: "text", text: output.join("\n") }],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error initializing knowledge base: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
