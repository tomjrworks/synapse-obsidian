import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../utils/storage.js";

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
- Flag contradictions with \\u26a0\\ufe0f, noting both positions
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

export function registerInitTools(
  server: McpServer,
  backend: StorageBackend,
): void {
  server.tool(
    "kb_init",
    `Initialize the knowledge base structure in the vault. Creates the full folder structure (raw/, wiki/, templates/), generates CLAUDE.md with the wiki schema, and creates the initial index and log files. Safe to run on an existing vault — won't overwrite existing files.`,
    {
      topic: z
        .string()
        .describe(
          "The topic or domain for this knowledge base (e.g. 'DeFi protocols', 'machine learning', 'competitive intelligence')",
        ),
    },
    async ({ topic }) => {
      try {
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
          const indexContent = INDEX_TEMPLATE.replace(
            /\{DATE\}/g,
            today,
          ).replace(/\{TOPIC\}/g, topic);
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
