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

/**
 * Generate a personalized CLAUDE.md from onboarding answers.
 * This is the single most important file in the vault — it makes Claude proactive.
 *
 * Exported for use by cloud.ts (Drive-based onboarding).
 *
 * Two layers:
 * 1. TABLE STAKES — always included, non-negotiable behaviors that make the brain work
 * 2. PERSONALIZED — shaped by onboarding answers (topic, purpose, folders, conventions)
 *
 * The file also self-updates: it tells Claude to modify these instructions when the
 * user expresses preferences about how they like things done.
 */
export function generateClaudeMd(opts: {
  topic: string;
  purpose: string;
  sourcesFolder: string;
  notesFolder: string;
  outputsFolder: string;
  fileNaming: string;
  useWikilinks: boolean;
  useFrontmatter: boolean;
  existingFolders?: string[];
}): string {
  const today = new Date().toISOString().split("T")[0];

  // Purpose-specific filing rules
  const purposeRows: Record<string, string> = {
    "knowledge-base": `| Research / analysis | \`${opts.notesFolder}/\` | kebab-case — create sub-folders by topic |
| Deep dive / evaluation | \`${opts.notesFolder}/<topic>/\` | kebab-case |
| Saved article or link | \`${opts.sourcesFolder}/\` | kebab-case |
| Query answer | \`${opts.outputsFolder}/\` | kebab-case |`,
    business: `| Client / project note | \`${opts.notesFolder}/<client>/\` | kebab-case |
| Meeting notes | \`${opts.notesFolder}/meetings/\` | \`YYYY-MM-DD-<topic>.md\` |
| Strategy / analysis | \`${opts.notesFolder}/\` | kebab-case |
| Saved article or link | \`${opts.sourcesFolder}/\` | kebab-case |
| Decision log | \`${opts.notesFolder}/decisions/\` | \`YYYY-MM-DD-<topic>.md\` |
| Query answer | \`${opts.outputsFolder}/\` | kebab-case |`,
    academic: `| Paper summary | \`${opts.notesFolder}/papers/\` | \`{author}-{year}-{short-title}.md\` |
| Course notes | \`${opts.notesFolder}/<course>/\` | kebab-case |
| Concept / topic page | \`${opts.notesFolder}/\` | kebab-case |
| Saved article or link | \`${opts.sourcesFolder}/\` | kebab-case |
| Query answer | \`${opts.outputsFolder}/\` | kebab-case |`,
    "life-os": `| Project note | \`${opts.notesFolder}/projects/<name>/\` | kebab-case |
| Research / analysis | \`${opts.notesFolder}/research/\` | kebab-case |
| Daily session log | \`${opts.notesFolder}/daily/\` | \`YYYY-MM-DD-<topic>.md\` |
| Decision log | \`${opts.notesFolder}/decisions/\` | \`YYYY-MM-DD-<topic>.md\` |
| Idea / half-baked thought | \`${opts.notesFolder}/ideas/\` | kebab-case |
| Saved article or link | \`${opts.sourcesFolder}/\` | kebab-case |
| Meeting notes | \`${opts.notesFolder}/meetings/\` | kebab-case with date |
| Query answer | \`${opts.outputsFolder}/\` | kebab-case |`,
  };

  const filingRows = purposeRows[opts.purpose] || purposeRows["knowledge-base"];

  // Build existing folders table rows
  let existingFolderRows = "";
  if (opts.existingFolders && opts.existingFolders.length > 0) {
    const knownFolders = [
      opts.sourcesFolder,
      opts.notesFolder,
      opts.outputsFolder,
      ".synapse",
    ];
    const otherFolders = opts.existingFolders.filter(
      (f) => !knownFolders.includes(f),
    );
    for (const f of otherFolders) {
      existingFolderRows += `| \`${f}/\` | (existing — preserved from your vault) |\n`;
    }
  }

  const namingRule =
    opts.fileNaming === "kebab-case"
      ? "kebab-case, lowercase (e.g., `active-inference.md`)"
      : opts.fileNaming === "title-case"
        ? "Title Case with spaces (e.g., `Active Inference.md`)"
        : "match whatever the user uses";

  const frontmatterBlock = opts.useFrontmatter
    ? `- Every page MUST have YAML frontmatter:
  \`\`\`
  ---
  title: "Page Title"
  date_created: YYYY-MM-DD
  date_modified: YYYY-MM-DD
  summary: "One-line description"
  tags: [relevant-tags]
  ---
  \`\`\``
    : "- Frontmatter is optional in this vault";

  const wikilinkRules = opts.useWikilinks
    ? `- Use [[wikilinks]] for all internal cross-references
- Link the first mention of a concept per section, not every mention
- **Never leave a [[wikilink]] pointing to nothing** — always create at least a stub`
    : "- Use standard markdown links for cross-references";

  return `# Synapse — Your AI Brain

> Created ${today} | Topic: ${opts.topic} | Purpose: ${opts.purpose}

## What This Vault Is

This is your second brain — a knowledge base that grows smarter with every conversation. You (the AI) are responsible for reading it, writing to it, and keeping it organized. The user directs strategy; you execute.

- Obsidian renders these files — use [[wikilinks]] to connect ideas
- All content is markdown — portable, future-proof, human-readable
- Every interaction should leave the vault better than you found it

---

## Read FIRST (before every answer)

**BLOCKING:** Before answering any question about ${opts.topic}, search the vault first. It has context that general knowledge will miss.

1. Read \`index.md\` to see what's in the vault
2. Search for relevant notes with \`vault_search\`
3. Read the most relevant pages before responding
4. Cite sources using [[wikilinks]] when drawing from vault content

This applies to every conversation, every question. The vault is the source of truth.

## Write AUTOMATICALLY (don't wait to be asked)

Don't wait until the end of a conversation to save things. Write to the vault **after each meaningful exchange**:

- **Research answers:** When you synthesize an answer worth keeping, save it to \`${opts.outputsFolder}/\`
- **New insights:** When the user shares something worth remembering, save it to \`${opts.notesFolder}/\`
- **Source material:** When saving articles or external content, use \`synapse_save\` → goes to \`${opts.sourcesFolder}/\`
- **Session logs:** After major milestones (research completed, decision made), write a note to \`${opts.notesFolder}/daily/\` in format \`YYYY-MM-DD-<topic>.md\`
- **Update the index:** After creating any new page, update \`index.md\` with a one-line summary
- **Connect ideas:** Add [[wikilinks]] to link related pages whenever you create or update content

**Don't log:** trivial questions, quick fixes, or exchanges with no lasting value.

---

## Folder Structure

| Folder | What goes here |
|--------|---------------|
| \`${opts.sourcesFolder}/\` | Raw source material — articles, links, pasted content |
| \`${opts.notesFolder}/\` | Organized knowledge — concepts, summaries, entities, analysis |
| \`${opts.outputsFolder}/\` | Saved query answers and research results |
${existingFolderRows}
**NEVER** create files at vault root. Only \`CLAUDE.md\` and \`index.md\` live there.

**Create sub-folders as the vault grows.** When a topic has 5+ notes, give it a sub-folder inside \`${opts.notesFolder}/\`. Let the structure grow organically — don't pre-create empty folders.

## Filing Rules — MANDATORY before every write

Before writing any file, determine its type and file it correctly:

| Note type | Goes in | Naming |
|---|---|---|
${filingRows}

**When unsure:** if it's organized knowledge → \`${opts.notesFolder}/\`. If it's raw external content → \`${opts.sourcesFolder}/\`. If it's an answer to a question → \`${opts.outputsFolder}/\`.

**Creating new sub-folders:** Allowed inside \`${opts.notesFolder}/\` when content doesn't fit existing sub-folders. Not allowed at vault root level.

---

## File Conventions

- Filenames: ${namingRule}
- Date format: YYYY-MM-DD
- Keep notes atomic — one idea per note when possible
${frontmatterBlock}
${wikilinkRules}

## Writing Style

- Direct, no fluff
- Bullet points over paragraphs
- Include "why" behind decisions, not just "what"
- Link to related notes with [[wikilinks]]

---

## Compounding Knowledge Loop

When synthesizing research or answering questions:

1. **Search the vault first** for prior answers on the topic
2. **If a note on this topic already exists — update it in place.** Don't create a duplicate.
   - Add a dated section at the top with the new information
   - Mark superseded sections with ~~strikethrough~~ or move to a "## Previous" section
   - One note per topic = single source of truth
3. If no prior note exists, create one in the appropriate folder (see filing rules)
4. Update \`index.md\` with the new or updated entry
5. Link back to related notes with [[wikilinks]]

### Handling Contradictions

- **When new info contradicts an existing note:** Update the existing note. Don't leave two notes that say different things.
- **When two existing notes conflict:** Add ⚠️ to the stale one with a link to the current one. Update or merge.
- **Always prefer recency.** When vault content conflicts, the most recently modified note wins — but verify it's not just newer-but-wrong.

## Marking Dead / Superseded Content

When a topic is abandoned, a strategy changes, or information becomes obsolete:

1. Add \`status: archived\` to the frontmatter
2. Add a bold line at the top: **⚠️ ARCHIVED (YYYY-MM-DD) — [reason].**
3. Update \`index.md\` — append "(ARCHIVED)" to the one-line summary

Never delete dead content — it has historical value. Just mark it clearly so searches don't surface it as active.

---

## Master Index

- **\`index.md\`** at vault root catalogs every page with a one-line summary
- **Read \`index.md\` first** when searching for vault content — before grepping
- **Update \`index.md\`** after creating or significantly updating any note
- Keep entries under 100 characters. Use [[wikilinks]]. Group by topic or folder.

## When New Sources Are Added

1. Read the source
2. Create a summary page in \`${opts.notesFolder}/\`
3. Identify key concepts and entities — create pages for each if they don't exist
4. Update existing pages with new information (append, don't overwrite)
5. Add [[wikilinks]] connecting new content to existing pages
6. Update \`index.md\`

## When Questions Are Asked

1. Check \`index.md\` and search the vault for relevant pages
2. Read the relevant pages
3. Synthesize an answer with [[wikilink]] citations
4. Save the answer to \`${opts.outputsFolder}/\`
5. Update \`index.md\`

## Quality Rules

- Summaries: 200-500 words, synthesize — don't copy
- Create a full page when a subject appears in 2+ sources
- For single-mention subjects, create a stub (one-line definition + link back)
- Never leave a [[wikilink]] pointing to nothing — always create at least a stub
- Flag contradictions with ⚠️, noting both positions
- Prefer recency when sources conflict
- Concept pages: 500-1500 words with a clear lead section
- Always trace claims to specific source pages

---

## Self-Updating Instructions

If the user expresses a preference about how they like work done — file naming, writing style, what to log, what not to log, folder organization — **update this CLAUDE.md file to reflect it.** These instructions should evolve to match how the user actually works.
`;
}

export const INDEX_TEMPLATE = `---
title: "Index"
date_modified: {DATE}
---

# {TOPIC} — Index

Everything in this vault, organized by topic.

## Notes
(Nothing yet — save an article or ask a question to get started)

## Sources
(No sources saved yet)

## Outputs
(No queries answered yet)
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
  let suggestedSourcesFolder = "sources";
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
 * Scaffold a new vault with personalized CLAUDE.md + lean folder structure.
 * Only creates sources/ + index.md + CLAUDE.md. The AI creates more folders organically.
 */
async function scaffoldStructuredVault(
  backend: StorageBackend,
  opts: {
    topic: string;
    purpose: string;
    sourcesFolder: string;
    notesFolder: string;
    outputsFolder: string;
    fileNaming: string;
    useWikilinks: boolean;
    useFrontmatter: boolean;
  },
): Promise<{ created: string[]; skipped: string[] }> {
  const today = new Date().toISOString().split("T")[0];
  const created: string[] = [];
  const skipped: string[] = [];

  // Create only the essential directories — AI creates more as content grows
  const dirs = [opts.sourcesFolder, opts.notesFolder, opts.outputsFolder];

  for (const dir of dirs) {
    if (!(await backend.exists(dir))) {
      await backend.mkdir(dir);
      created.push(`${dir}/`);
    }
  }

  // Create personalized CLAUDE.md
  if (!(await backend.exists("CLAUDE.md"))) {
    const claudeContent = generateClaudeMd(opts);
    await backend.writeFile("CLAUDE.md", claudeContent);
    created.push("CLAUDE.md");
  } else {
    skipped.push("CLAUDE.md (already exists)");
  }

  // Create index.md at vault root
  if (!(await backend.exists("index.md"))) {
    const indexContent = INDEX_TEMPLATE.replace(/\{DATE\}/g, today).replace(
      /\{TOPIC\}/g,
      opts.topic,
    );
    await backend.writeFile("index.md", indexContent);
    created.push("index.md");
  } else {
    skipped.push("index.md (already exists)");
  }

  return { created, skipped };
}

export function registerInitTools(
  server: McpServer,
  backend: StorageBackend,
): void {
  // ── synapse_setup ────────────────────────────────────────────────────
  server.registerTool(
    "synapse_setup",
    {
      title: "Synapse Setup",
      description: `Onboarding entry point for Synapse. Scans the vault to detect existing structure, conventions, and CLAUDE.md, then returns configuration options for the user to choose from:
- Option A: Use existing vault conventions (adapts to what's already there)
- Option B: Set up a structured knowledge base (organized folders for a specific topic)
- Option C: Start fresh with custom settings

After the user chooses, call synapse_configure with their selection.`,
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
          `synapse_configure({ mode: "existing" })`,
          "```",
          "",
        );

        // Option B
        output.push(
          "### Option B: Set Up Structured Knowledge Base",
          "",
          "Creates an organized vault: `sources/` for raw material, organized folders for compiled knowledge, `CLAUDE.md` schema. Best for building a focused knowledge base on a specific topic.",
          "",
          "To choose this, call:",
          "```",
          `synapse_configure({ mode: "structured", topic: "your topic here" })`,
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
          `synapse_configure({ mode: "custom", sourcesFolder: "...", outputsFolder: "...", fileNaming: "kebab-case" })`,
          "```",
          "",
        );

        output.push(
          "---",
          "",
          "### Also ask: What will you use this vault for?",
          "",
          "This helps Synapse tailor how it saves and organizes content:",
          "",
          '- **"knowledge-base"** — Research, learning, building a personal wiki on a topic',
          '- **"business"** — Clients, projects, strategy, meetings, CRM-like notes',
          '- **"academic"** — Papers, literature review, citations, coursework',
          '- **"life-os"** — Everything: projects, ideas, research, daily notes, personal + work',
          '- **"custom"** — Something else (ask them to describe it)',
          "",
          "Pass their answer as `purpose` (and `purposeDescription` if custom) when calling `synapse_configure`.",
          "",
          "---",
          "",
          "**Ask the user which option (A/B/C) they prefer and what they'll use the vault for**, then call `synapse_configure` with both.",
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

  // ── synapse_configure ────────────────────────────────────────────────
  server.registerTool(
    "synapse_configure",
    {
      title: "Configure Synapse",
      description: `Save Synapse configuration based on the user's choice from synapse_setup. Three modes:
- "existing": Auto-detect conventions from the vault and save config. No folders created.
- "structured": Set up an organized knowledge base (creates sources/, notes/, CLAUDE.md). Requires a topic.
- "custom": Save whatever folder paths and conventions the user specified.`,
      inputSchema: {
        mode: z
          .enum(["existing", "structured", "kb", "custom"])
          .describe(
            "Configuration mode chosen by the user ('kb' accepted as alias for 'structured')",
          ),
        sourcesFolder: z
          .string()
          .optional()
          .describe(
            "Where to save raw articles (default: auto-detect or 'sources')",
          ),
        wikiFolder: z
          .string()
          .optional()
          .describe(
            "Where organized notes go (default: 'notes' for structured mode, null for existing)",
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
        purpose: z
          .enum(["knowledge-base", "business", "academic", "life-os", "custom"])
          .optional()
          .describe("What the user will use this vault for"),
        purposeDescription: z
          .string()
          .optional()
          .describe("Custom purpose description (when purpose is 'custom')"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      mode,
      sourcesFolder,
      wikiFolder,
      outputsFolder,
      topic,
      fileNaming,
      purpose,
      purposeDescription,
    }) => {
      try {
        const config: SynapseConfig = getDefaultConfig();
        config.mode = mode;
        config.purpose = purpose || null;
        config.purposeDescription = purposeDescription || null;
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
                  `- **Purpose:** ${config.purpose || "not set"}${config.purposeDescription ? ` — ${config.purposeDescription}` : ""}`,
                  "",
                  "Config saved to `.synapse/config.json`. All tools will now use these settings.",
                  "",
                  "### Next Steps",
                  `1. Save articles with \`synapse_save\` — they'll go to \`${config.sourcesFolder}\``,
                  "2. Use `synapse_status` to see your vault overview",
                  "3. Use `synapse_query` to research your existing notes",
                ].join("\n"),
              },
            ],
          };
        }

        if (mode === "structured" || mode === "kb") {
          if (!topic) {
            return {
              content: [
                {
                  type: "text",
                  text: 'Error: Structured mode requires a `topic` parameter (e.g. "machine learning", "DeFi protocols").',
                },
              ],
              isError: true,
            };
          }

          const resolvedSources = sourcesFolder || "sources";
          const resolvedNotes = wikiFolder || "notes";
          const resolvedOutputs = outputsFolder || "outputs";
          const resolvedNaming = fileNaming || "kebab-case";

          // Run the scaffold with personalized CLAUDE.md
          const { created, skipped } = await scaffoldStructuredVault(backend, {
            topic,
            purpose: purpose || "knowledge-base",
            sourcesFolder: resolvedSources,
            notesFolder: resolvedNotes,
            outputsFolder: resolvedOutputs,
            fileNaming: resolvedNaming,
            useWikilinks: true,
            useFrontmatter: true,
          });

          config.sourcesFolder = resolvedSources;
          config.wikiFolder = resolvedNotes;
          config.outputsFolder = resolvedOutputs;
          config.fileNaming = resolvedNaming;
          config.useFrontmatter = true;
          config.useWikilinks = true;
          config.schemaPath = "CLAUDE.md";
          config.topic = topic;

          await saveConfig(backend, config);

          const output = [
            "## Knowledge Base Initialized & Configured",
            "",
            `**Topic:** ${topic}`,
            `**Mode:** Structured Knowledge Base`,
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
            "1. Add source articles to `sources/` (copy-paste or use `synapse_save` with a URL)",
            "2. Run `synapse_compile` to see what needs processing",
            "3. Run `synapse_ingest` for each source to build organized pages",
            "4. Ask questions with `synapse_query`",
            "5. Run `synapse_lint` periodically to maintain quality",
          );

          return {
            content: [{ type: "text", text: output.join("\n") }],
          };
        }

        // Custom mode
        config.sourcesFolder = sourcesFolder || "sources";
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
                `1. Save articles with \`synapse_save\` — they'll go to \`${config.sourcesFolder}\``,
                "2. Use `synapse_status` to see your vault overview",
                "3. Use `synapse_query` to research your notes",
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

  // ── synapse_init (kept as alias, points users to synapse_setup) ──────
  server.registerTool(
    "synapse_init",
    {
      title: "Initialize Knowledge Base",
      description: `Initialize a structured knowledge base in the vault. Creates the folder structure, generates CLAUDE.md with the schema, and creates the initial index and log files. Safe to run on an existing vault — won't overwrite existing files.

**For new vaults only.** If you have an existing vault, use \`synapse_setup\` instead — it detects your conventions and adapts.`,
      inputSchema: {
        topic: z
          .string()
          .describe(
            "The topic or domain for this knowledge base (e.g. 'DeFi protocols', 'machine learning', 'competitive intelligence')",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ topic }) => {
      try {
        const { created, skipped } = await scaffoldStructuredVault(backend, {
          topic,
          purpose: "knowledge-base",
          sourcesFolder: "sources",
          notesFolder: "notes",
          outputsFolder: "outputs",
          fileNaming: "kebab-case",
          useWikilinks: true,
          useFrontmatter: true,
        });

        // Also save config automatically
        const config: SynapseConfig = getDefaultConfig();
        config.mode = "structured";
        config.sourcesFolder = "sources";
        config.wikiFolder = "notes";
        config.outputsFolder = "outputs";
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
          "1. Add source articles to `sources/` (copy-paste or use `synapse_save` with a URL)",
          "2. Run `synapse_compile` to see what needs processing",
          "3. Run `synapse_ingest` for each source to build organized pages",
          "4. Ask questions with `synapse_query`",
          "5. Run `synapse_lint` periodically to maintain quality",
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
