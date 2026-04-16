import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "./utils/storage.js";

/**
 * Read the vault's CLAUDE.md schema if it exists, or return a fallback message.
 */
async function getSchema(backend: StorageBackend): Promise<string> {
  try {
    if (await backend.exists("CLAUDE.md")) {
      return await backend.readFile("CLAUDE.md");
    }
  } catch {
    // ignore read errors
  }
  return "(No CLAUDE.md found — run synapse_setup to configure Synapse, or synapse_init to set up a knowledge base schema.)";
}

export function registerPrompts(
  server: McpServer,
  backend: StorageBackend,
): void {
  // ── compile ───────────────────────────────────────────────────────
  server.prompt(
    "compile",
    "Process all new sources in the knowledge base. Finds unprocessed raw sources and ingests each one into the wiki.",
    async () => {
      const schema = await getSchema(backend);
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                "Process all new sources in my knowledge base.",
                "",
                "## Schema (CLAUDE.md)",
                "```markdown",
                schema,
                "```",
                "",
                "## Steps",
                "1. Call `synapse_status` to check the current state",
                "2. Call `synapse_compile` to find all unprocessed sources",
                "3. For each unprocessed source, call `synapse_ingest` with its path",
                "4. After ingesting each source, use `vault_write` to create the pages as instructed",
                "5. When all sources are processed, give me a summary of what was added",
                "",
                "Process them one at a time. Follow the schema above for all file conventions.",
              ].join("\n"),
            },
          },
        ],
      };
    },
  );

  // ── research ──────────────────────────────────────────────────────
  server.prompt(
    "research",
    "Research a question across the knowledge base, synthesize an answer with citations, and save it.",
    { question: z.string() },
    async ({ question }) => {
      const schema = await getSchema(backend);
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                `Research this question across my knowledge base: "${question}"`,
                "",
                "## Schema (CLAUDE.md)",
                "```markdown",
                schema,
                "```",
                "",
                "## Steps",
                `1. Call \`synapse_query\` with question: "${question}"`,
                "2. Read the returned pages carefully",
                "3. Synthesize a comprehensive answer with [[wikilink]] citations to source pages",
                "4. Save the answer using `vault_write` (the synapse_query response will include the exact path and template)",
                "5. Update index.md to include the new output",
                "",
                "If the knowledge base doesn't have enough information, say what's missing and suggest sources to add.",
              ].join("\n"),
            },
          },
        ],
      };
    },
  );

  // ── health-check ──────────────────────────────────────────────────
  server.prompt(
    "health-check",
    "Run a health check on the knowledge base. Lint for issues and fix what you can.",
    async () => {
      const schema = await getSchema(backend);
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                "Run a health check on my knowledge base and fix any issues you find.",
                "",
                "## Schema (CLAUDE.md)",
                "```markdown",
                schema,
                "```",
                "",
                "## Steps",
                "1. Call `synapse_lint` to scan for issues (broken links, orphans, missing frontmatter, stale content)",
                "2. Review the report",
                "3. For each broken link: create a stub page with frontmatter using `vault_write`",
                "4. For each page with missing frontmatter: read it with `vault_read`, then fix it with `vault_write`",
                "5. For orphan pages: suggest connections to existing content",
                "6. Save the lint report to the outputs folder using `vault_write`",
                "7. Give me a summary of what was found and fixed",
              ].join("\n"),
            },
          },
        ],
      };
    },
  );

  // ── save-article ──────────────────────────────────────────────────
  server.prompt(
    "save-article",
    "Save an article from a URL to the knowledge base and process it into the wiki.",
    { url: z.string() },
    async ({ url }) => {
      const schema = await getSchema(backend);
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                `Save this article to my knowledge base and process it: ${url}`,
                "",
                "## Schema (CLAUDE.md)",
                "```markdown",
                schema,
                "```",
                "",
                "## Steps",
                `1. Call \`synapse_save\` with the URL: "${url}" — pick a descriptive title based on the URL/domain`,
                "2. Review the saved content to make sure it captured the article text",
                "3. Call `synapse_ingest` with the saved file path to process it into organized notes",
                "4. Use `vault_write` to create the pages as instructed by synapse_ingest",
                "5. Give me a summary of the article and what pages were created",
              ].join("\n"),
            },
          },
        ],
      };
    },
  );

  // ── getting-started ───────────────────────────────────────────────
  server.prompt(
    "getting-started",
    "Build my brain — reads your files, organizes everything, and makes it searchable.",
    async () => {
      // Detect vault structure to give Claude the right instructions
      const hasSourcesFolder = await backend.exists("sources");
      const sourcesFolder = hasSourcesFolder ? "sources" : "raw";

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                "I just connected my files. Help me build my brain.",
                "",
                "## RULES — How to talk to the user",
                "- Plain, friendly English. NO technical jargon ever.",
                "- Never show tool names, function names, folder paths, or code.",
                "- Never say 'knowledge base', 'compile', 'ingest', 'wiki', 'schema', 'sourcesFolder', 'raw/', etc.",
                "- Instead say 'brain', 'organize', 'read', 'build', 'notes', 'files'.",
                "",
                "## PHASE 1 — Ask two simple questions (and ONLY these two)",
                "",
                'Ask: "What would you like your brain to help you with? For example: work projects, school, research, personal notes, or something else?"',
                "",
                'Then ask: "What topics matter most to you? Just list a few words or phrases — I\'ll organize your files around them."',
                "",
                "Wait for answers before proceeding. These are the ONLY questions to ask.",
                "",
                "## PHASE 2 — Set everything up (silently, behind the scenes)",
                `After getting answers, run these tools WITHOUT narrating the tool names:`,
                `1. synapse_setup — to scan the vault`,
                `2. synapse_configure — with sourcesFolder="${sourcesFolder}", mode="structured", purpose set from user's answer to Q1, topic set from user's answer to Q2. Accept all other defaults from scan.`,
                `3. synapse_compile — to find files that need processing`,
                "",
                "Narrate to the user as:",
                '"Thanks! Let me scan your files..."',
                '"Found X files. I\'m going to read through them and organize everything for you."',
                "",
                "## PHASE 3 — Process files",
                "For each unprocessed file from synapse_compile:",
                "1. Run synapse_ingest with the file path",
                "2. Run vault_write to create the organized pages",
                "3. Briefly tell the user: 'Reading: [simple filename]... done.'",
                "",
                "Process up to 10 files. If there are more, say:",
                "\"I've organized 10 of your files so far. Here's what I built: [brief summary]. Say **keep going** and I'll do the next batch.\"",
                "",
                "## PHASE 4 — Summary",
                "When done (or after first batch), give a warm summary:",
                "\"Your brain is ready! Here's what's inside:\"",
                "- List the main topics/themes found",
                "- Tell them what they can do: 'Try asking me anything about your files — like [example question based on their actual content]'",
                "- Mention they can save new stuff anytime: 'You can also share articles or notes with me anytime and I\\'ll add them to your brain.'",
              ].join("\n"),
            },
          },
        ],
      };
    },
  );
}
