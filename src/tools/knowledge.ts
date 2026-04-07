import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import fs from "node:fs";
import {
  readVaultFile,
  writeVaultFile,
  listVaultFiles,
  searchVault,
  parseFrontmatter,
} from "../utils/vault.js";

const TODAY = () => new Date().toISOString().split("T")[0];

export function registerKnowledgeTools(
  server: McpServer,
  vaultPath: string,
): void {
  // --- INGEST ---
  server.tool(
    "kb_ingest",
    `Process a raw source file into the knowledge base wiki. Reads the source, generates a summary page in wiki/sources/, identifies concepts and entities, creates or updates their pages, adds [[wikilinks]], and updates the master index and log.

You MUST read the source file content first, then generate all wiki pages. Follow the CLAUDE.md schema in the vault root for conventions.

Steps:
1. Read the raw source file
2. Create wiki/sources/{author}-{year}-{short-title}.md with summary
3. For each key concept: create/update wiki/concepts/{concept}.md
4. For each key entity: create/update wiki/entities/{entity}.md
5. Add [[wikilinks]] connecting related pages
6. Update wiki/index.md with new entries
7. Append to wiki/log.md`,
    {
      sourcePath: z
        .string()
        .describe(
          "Path to the raw source file relative to vault (e.g. 'raw/articles/my-article.md')",
        ),
    },
    async ({ sourcePath }) => {
      try {
        // Read the source
        const content = readVaultFile(vaultPath, sourcePath);
        const fm = parseFrontmatter(content);

        // Check if already processed
        const sourcesDir = "wiki/sources";
        const existingSources = listVaultFiles(vaultPath, sourcesDir);
        const sourceBasename = path.basename(sourcePath, ".md");

        const alreadyProcessed = existingSources.some((f) =>
          f.includes(sourceBasename),
        );

        // Read existing index if it exists
        let existingIndex = "";
        const indexPath = path.join(vaultPath, "wiki", "index.md");
        if (fs.existsSync(indexPath)) {
          existingIndex = fs.readFileSync(indexPath, "utf-8");
        }

        // Read CLAUDE.md if it exists
        let schema = "";
        const claudePath = path.join(vaultPath, "CLAUDE.md");
        if (fs.existsSync(claudePath)) {
          schema = fs.readFileSync(claudePath, "utf-8");
        }

        // Return context for the AI to do the actual compilation
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
          "### Current Wiki Index",
          existingIndex
            ? "```markdown\n" + existingIndex.slice(0, 5000) + "\n```"
            : "(No index yet — this is the first ingest)",
          "",
          schema
            ? "### Wiki Schema (CLAUDE.md)\n```markdown\n" +
              schema.slice(0, 3000) +
              "\n```"
            : "",
          "",
          "### Instructions",
          "",
          "Now use `vault_write` to create/update the following files:",
          "1. `wiki/sources/{author}-{year}-{short-title}.md` — 200-500 word summary with frontmatter",
          "2. `wiki/concepts/{concept-name}.md` — for each key concept (create if 2+ mentions, stub if 1)",
          "3. `wiki/entities/{entity-name}.md` — for people, orgs, tools mentioned",
          "4. `wiki/index.md` — updated master index with new entries",
          "5. `wiki/log.md` — append ingest record",
          "",
          "Use [[wikilinks]] for all cross-references. Use kebab-case filenames.",
          "Every page MUST have YAML frontmatter (title, date_created, date_modified, summary, tags, type, status).",
        ].join("\n");

        return { content: [{ type: "text", text: output }] };
      } catch (err: any) {
        return {
          content: [
            { type: "text", text: `Error preparing ingest: ${err.message}` },
          ],
          isError: true,
        };
      }
    },
  );

  // --- COMPILE ---
  server.tool(
    "kb_compile",
    `Scan for all unprocessed raw sources and compile them into the wiki. Lists which sources exist in raw/ but don't have corresponding summaries in wiki/sources/. Use kb_ingest on each one to process them.`,
    {},
    async () => {
      try {
        const rawFiles = listVaultFiles(vaultPath, "raw");
        const wikiSources = listVaultFiles(vaultPath, "wiki/sources");

        if (rawFiles.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No files found in raw/. Add source articles to raw/articles/ first.",
              },
            ],
          };
        }

        // Find unprocessed sources
        const sourceBasenames = new Set(
          wikiSources.map((f) => path.basename(f, ".md").toLowerCase()),
        );

        const unprocessed: string[] = [];
        const processed: string[] = [];

        for (const rawFile of rawFiles) {
          const basename = path.basename(rawFile, ".md").toLowerCase();
          // Check if any wiki source contains this basename
          const isProcessed = [...sourceBasenames].some(
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
          output.push("Call `kb_ingest` for each of these:\n");
          for (const f of unprocessed) {
            output.push(`- ${f}`);
          }
          output.push("");
          output.push(
            `Start with: kb_ingest({ sourcePath: "${unprocessed[0]}" })`,
          );
        } else {
          output.push("All sources have been processed. Wiki is up to date.");
        }

        return { content: [{ type: "text", text: output.join("\n") }] };
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

  // --- QUERY ---
  server.tool(
    "kb_query",
    `Research a question against the knowledge base wiki. Reads the index, identifies relevant pages, and returns their content so you can synthesize an answer. After answering, save the result to wiki/outputs/ using vault_write.`,
    {
      question: z.string().describe("The question to research"),
    },
    async ({ question }) => {
      try {
        // Read the index
        let index = "";
        const indexPath = path.join(vaultPath, "wiki", "index.md");
        if (fs.existsSync(indexPath)) {
          index = readVaultFile(vaultPath, "wiki/index.md");
        }

        // Search for relevant content
        const keywords = question
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 3);

        const allResults: Map<string, string> = new Map();

        for (const keyword of keywords.slice(0, 5)) {
          const results = searchVault(vaultPath, keyword, {
            subPath: "wiki",
            maxResults: 10,
          });
          for (const r of results) {
            if (!allResults.has(r.file)) {
              allResults.set(r.file, r.title);
            }
          }
        }

        // Read the most relevant pages (up to 10)
        const relevantFiles = [...allResults.entries()].slice(0, 10);
        const pageContents: string[] = [];

        for (const [file] of relevantFiles) {
          try {
            const content = readVaultFile(vaultPath, file);
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
          "### Wiki Index",
          index
            ? "```markdown\n" + index.slice(0, 5000) + "\n```"
            : "(No index found — run kb_compile first)",
          "",
          `### Relevant Pages (${relevantFiles.length} found)`,
          "",
          ...pageContents,
          "",
          "### Instructions",
          "",
          "Synthesize an answer to the question using the wiki content above.",
          "- Cite sources using [[wikilinks]]",
          "- If information is insufficient, say what's missing",
          `- Save your answer using vault_write to: wiki/outputs/${slugify(question)}.md`,
          "- Include frontmatter: title, date_created, summary, tags, type: output",
          "- Update wiki/index.md and wiki/log.md",
        ].join("\n");

        return { content: [{ type: "text", text: output }] };
      } catch (err: any) {
        return {
          content: [
            { type: "text", text: `Error researching query: ${err.message}` },
          ],
          isError: true,
        };
      }
    },
  );

  // --- LINT ---
  server.tool(
    "kb_lint",
    `Health-check the knowledge base wiki. Scans for contradictions, orphan pages, broken wikilinks, missing frontmatter, stale content, and missing pages. Returns a report and instructions for fixing issues.`,
    {},
    async () => {
      try {
        const wikiFiles = listVaultFiles(vaultPath, "wiki");

        if (wikiFiles.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No wiki files found. Run kb_init to set up the knowledge base first.",
              },
            ],
          };
        }

        // Collect all wikilinks and frontmatter
        const allLinks = new Set<string>();
        const allPages = new Set<string>();
        const issues: string[] = [];
        const orphans: string[] = [];
        const missingFm: string[] = [];
        const stalePages: string[] = [];
        const brokenLinks: string[] = [];

        const inboundLinks = new Map<string, number>();

        for (const file of wikiFiles) {
          const basename = path.basename(file, ".md");
          allPages.add(basename);
          inboundLinks.set(basename, 0);
        }

        for (const file of wikiFiles) {
          const content = readVaultFile(vaultPath, file);
          const fm = parseFrontmatter(content);

          // Check frontmatter
          if (!fm.title || !fm.type || !fm.date_created) {
            missingFm.push(file);
          }

          // Check staleness (>6 months)
          if (fm.date_modified || fm.date_created) {
            const date = new Date(fm.date_modified || fm.date_created);
            const sixMonthsAgo = new Date();
            sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
            if (date < sixMonthsAgo) {
              stalePages.push(file);
            }
          }

          // Extract wikilinks
          const linkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
          let match;
          while ((match = linkRegex.exec(content)) !== null) {
            const linkTarget = match[1].toLowerCase().replace(/\s+/g, "-");
            allLinks.add(linkTarget);

            // Track inbound links
            const current = inboundLinks.get(linkTarget) || 0;
            inboundLinks.set(linkTarget, current + 1);

            // Check if target exists
            if (!allPages.has(linkTarget)) {
              brokenLinks.push(`${file} -> [[${match[1]}]]`);
            }
          }
        }

        // Find orphans (no inbound links, not index/log)
        for (const file of wikiFiles) {
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

        // Build report
        const report = [
          "## Wiki Health Check Report",
          `**Date:** ${TODAY()}`,
          `**Total pages:** ${wikiFiles.length}`,
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
            `Save this report using vault_write to: wiki/outputs/lint-report-${TODAY()}.md`,
          );
        }

        return { content: [{ type: "text", text: report.join("\n") }] };
      } catch (err: any) {
        return {
          content: [
            { type: "text", text: `Error running lint: ${err.message}` },
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
