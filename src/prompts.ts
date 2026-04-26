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
  return "(No CLAUDE.md found — run taproot_plant to configure Taproot, or taproot_sow to scaffold a knowledge base schema.)";
}

export function registerPrompts(
  server: McpServer,
  backend: StorageBackend,
): void {
  // ── compile ───────────────────────────────────────────────────────
  server.registerPrompt(
    "compile",
    {
      title: "Compile sources",
      description:
        "Process all unprocessed sources in your garden into organized notes with [[wikilinks]].",
    },
    async () => {
      const schema = await getSchema(backend);
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                "Process all new sources in my garden.",
                "",
                "## Schema (CLAUDE.md)",
                "```markdown",
                schema,
                "```",
                "",
                "## Steps",
                "1. Call `taproot_status` to check the current state",
                "2. Call `taproot_cultivate` to find all unprocessed sources",
                "3. For each unprocessed source, call `taproot_water` with its path",
                "4. After ingesting each source, use `garden_plant` to create the pages as instructed",
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
  server.registerPrompt(
    "research",
    {
      title: "Research a question",
      description:
        "Research a question across your garden, synthesize an answer with citations, and save it.",
      argsSchema: { question: z.string() },
    },
    async ({ question }) => {
      const schema = await getSchema(backend);
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                `Research this question across my garden: "${question}"`,
                "",
                "## Schema (CLAUDE.md)",
                "```markdown",
                schema,
                "```",
                "",
                "## Steps",
                `1. Call \`taproot_harvest\` with question: "${question}"`,
                "2. Read the returned pages carefully",
                "3. Synthesize a comprehensive answer with [[wikilink]] citations to source pages",
                "4. Save the answer using `garden_plant` (the taproot_harvest response will include the exact path and template)",
                "5. Update index.md to include the new output",
                "",
                "If the garden doesn't have enough information, say what's missing and suggest sources to add.",
              ].join("\n"),
            },
          },
        ],
      };
    },
  );

  // ── health-check ──────────────────────────────────────────────────
  server.registerPrompt(
    "health-check",
    {
      title: "Garden health check",
      description:
        "Audit your garden for broken links, orphan pages, missing frontmatter, and stale content — and fix what can be fixed.",
    },
    async () => {
      const schema = await getSchema(backend);
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                "Run a health check on my garden and fix any issues you find.",
                "",
                "## Schema (CLAUDE.md)",
                "```markdown",
                schema,
                "```",
                "",
                "## Steps",
                "1. Call `taproot_prune` to scan for issues (broken links, orphans, missing frontmatter, stale content)",
                "2. Review the report",
                "3. For each broken link: create a stub page with frontmatter using `garden_plant`",
                "4. For each page with missing frontmatter: read it with `garden_read`, then fix it with `garden_plant`",
                "5. For orphan pages: suggest connections to existing content",
                "6. Save the lint report to the outputs folder using `garden_plant`",
                "7. Give me a summary of what was found and fixed",
              ].join("\n"),
            },
          },
        ],
      };
    },
  );

  // ── save-article ──────────────────────────────────────────────────
  server.registerPrompt(
    "save-article",
    {
      title: "Save an article",
      description:
        "Save an article from a URL to your garden using the single-call save path.",
      argsSchema: { url: z.string() },
    },
    async ({ url }) => {
      const schema = await getSchema(backend);
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                `Save this article to my garden: ${url}`,
                "",
                "## Schema (CLAUDE.md)",
                "```markdown",
                schema,
                "```",
                "",
                "## Steps",
                `1. Call \`taproot_save_url({ url: "${url}" })\` — single call: fetches, extracts, files under sources/`,
                "2. Confirm the save and tell me the path + a 1-sentence summary of what's in it",
                "3. Only run `taproot_water` afterward if I explicitly ask for the full processing pipeline",
              ].join("\n"),
            },
          },
        ],
      };
    },
  );

  // ── getting-started ───────────────────────────────────────────────
  server.registerPrompt(
    "getting-started",
    {
      title: "Build my brain",
      description:
        "First-run onboarding — reads your files, organizes everything, and makes it searchable.",
    },
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
                `1. taproot_plant — to scan the vault`,
                `2. taproot_till — with sourcesFolder="${sourcesFolder}", mode="structured", purpose set from user's answer to Q1, topic set from user's answer to Q2. Accept all other defaults from scan.`,
                `3. taproot_cultivate — to find files that need processing`,
                "",
                "Narrate to the user as:",
                '"Thanks! Let me scan your files..."',
                '"Found X files. I\'m going to read through them and organize everything for you."',
                "",
                "## PHASE 3 — Process files",
                "For each unprocessed file from taproot_cultivate:",
                "1. Run taproot_water with the file path",
                "2. Run garden_plant to create the organized pages",
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
