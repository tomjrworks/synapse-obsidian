import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../utils/storage.js";
import { checkToolRateLimit, rateLimitToolError } from "./_rate-limit.js";

const STARTER_RULES = `# Filing Rules (starter — no CLAUDE.md yet)

This vault has no CLAUDE.md yet, so the AI assistant has no learned filing
conventions to follow. These starter rules are a sensible default; the
user should personalize them.

## Folders
- \`daily/\` — work session logs (\`YYYY-MM-DD-<topic>.md\`)
- \`decisions/\` — decisions with reasoning (\`YYYY-MM-DD-<topic>.md\`)
- \`research/\` — research and analysis (always inside a subfolder, never flat)
- \`projects/\` — per-project notes
- \`ideas/\` — half-baked thoughts
- \`references/\` — external info, bookmarks, tool evals
- \`meetings/\` — meeting notes

## Rules
- Never create files at vault root except CLAUDE.md and index.md
- File names: lowercase-kebab-case.md
- Use [[backlinks]] to connect related notes
- Tag notes with relevant project (\`#<project>\`)
- When in doubt, use \`projects/<project>/\` if project-specific or
  \`research/<topic>/\` if analytical

## Writing
- Direct, no fluff
- Bullets over paragraphs
- Include "why" behind decisions, not just "what"
`;

export function registerRulesTool(
  server: McpServer,
  backend: StorageBackend,
  opts: { workspaceId?: string } = {},
): void {
  server.registerTool(
    "garden_rules",
    {
      title: "Vault filing rules",
      description:
        "Use this BEFORE answering project questions, suggesting where to save a note, or proposing folder structure for the user's vault. Returns the user's CLAUDE.md — the filing rules, folder taxonomy, naming conventions, and writing patterns established for this vault. If no CLAUDE.md exists yet, returns starter rules with a note. Triggers: 'where should I save this', 'what's the folder structure', 'how does the user organize X', 'before I save', any time you're about to call garden_plant in an unfamiliar folder. CURATION: CLAUDE.md is mutable — when you observe the user has a consistent filing pattern (3+ saves with the same shape), offer to add it as a rule. On consent, splice the rule between the TAPROOT-MANAGED:filing markers and write back via garden_plant({ path: 'CLAUDE.md', acknowledgeRoot: true }); the merge logic preserves user hand-edits outside the markers.",
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
        "garden_rules",
        "read",
      );
      if (limited) return rateLimitToolError(limited);
      try {
        if (await backend.exists("CLAUDE.md")) {
          const content = await backend.readFile("CLAUDE.md");
          return {
            content: [
              {
                type: "text",
                text: `<vault-rules source="CLAUDE.md">\n${content}\n</vault-rules>`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `<vault-rules source="starter" note="No CLAUDE.md yet — these are starter defaults, not the user's chosen conventions. The user can personalize via taproot_plant + taproot_till or by hand-editing CLAUDE.md.">\n${STARTER_RULES}\n</vault-rules>`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error reading filing rules: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
