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
  return "(No CLAUDE.md found — run kb_setup to configure Synapse, or kb_init to set up a knowledge base schema.)";
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
                "## Wiki Schema (CLAUDE.md)",
                "```markdown",
                schema,
                "```",
                "",
                "## Steps",
                "1. Call `kb_status` to check the current state",
                "2. Call `kb_compile` to find all unprocessed sources",
                "3. For each unprocessed source, call `kb_ingest` with its path",
                "4. After ingesting each source, use `vault_write` to create the wiki pages as instructed",
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
                "## Wiki Schema (CLAUDE.md)",
                "```markdown",
                schema,
                "```",
                "",
                "## Steps",
                `1. Call \`kb_query\` with question: "${question}"`,
                "2. Read the returned wiki pages carefully",
                "3. Synthesize a comprehensive answer with [[wikilink]] citations to source pages",
                "4. Save the answer to wiki/outputs/ using `vault_write` (the kb_query response will include the exact path and template)",
                "5. Update wiki/index.md to include the new output",
                "6. Append a log entry to wiki/log.md",
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
                "## Wiki Schema (CLAUDE.md)",
                "```markdown",
                schema,
                "```",
                "",
                "## Steps",
                "1. Call `kb_lint` to scan for issues (broken links, orphans, missing frontmatter, stale content)",
                "2. Review the report",
                "3. For each broken link: create a stub page with frontmatter using `vault_write`",
                "4. For each page with missing frontmatter: read it with `vault_read`, then fix it with `vault_write`",
                "5. For orphan pages: suggest connections to existing content",
                "6. Save the lint report to wiki/outputs/ using `vault_write`",
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
                "## Wiki Schema (CLAUDE.md)",
                "```markdown",
                schema,
                "```",
                "",
                "## Steps",
                `1. Call \`kb_save\` with the URL: "${url}" — pick a descriptive title based on the URL/domain`,
                "2. Review the saved content to make sure it captured the article text",
                "3. Call `kb_ingest` with the saved file path to process it into the wiki",
                "4. Use `vault_write` to create the wiki pages as instructed by kb_ingest",
                "5. Give me a summary of the article and what wiki pages were created",
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
    "Set up your brain — one click. Scans your files, configures everything, and compiles your knowledge base.",
    async () => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                "I just connected my files. Set up my brain and make it work.",
                "",
                "## What to do (run these steps automatically, don't ask me questions)",
                "1. Call `kb_setup` to scan my vault",
                "2. Call `kb_configure` with purpose 'knowledge-base' and accept the defaults from the scan",
                "3. Call `kb_status` to confirm setup worked",
                "4. Call `kb_compile` to find all sources that need processing",
                "5. For each unprocessed source, call `kb_ingest` with its path",
                "6. After ingesting each source, use `vault_write` to create the wiki pages",
                "7. When done, give me a friendly summary of what my brain now contains",
                "",
                "Do NOT ask me to choose options or make decisions. Just use sensible defaults and go.",
                "Narrate what you're doing in plain English as you go — I want to see the magic happen.",
                "If there are too many sources to process in one go, do the first 10 and tell me to say 'continue' for more.",
              ].join("\n"),
            },
          },
        ],
      };
    },
  );
}
