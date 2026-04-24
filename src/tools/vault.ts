import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../utils/storage.js";
import {
  readVaultFile,
  writeVaultFile,
  listVaultFiles,
  searchVault,
  getVaultStats,
  parseFrontmatter,
} from "../utils/vault.js";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function getFilingHint(
  backend: StorageBackend,
  filePath: string,
): Promise<string | null> {
  try {
    if (!(await backend.exists("CLAUDE.md"))) return null;
    const claude = await backend.readFile("CLAUDE.md");
    const topLevel = filePath.split("/")[0];
    if (!topLevel || topLevel === filePath) return null;
    // Word-boundary match: topLevel/ must be at line start or preceded by a
    // non-word, non-hyphen char (e.g. backtick, space, pipe). Prevents
    // `research/product-ideas/` from matching when topLevel is `ideas`.
    const pattern = new RegExp(`(?:^|[^\\w-])${escapeRegex(topLevel)}/`);
    const matches = claude
      .split("\n")
      .filter((line) => pattern.test(line))
      .slice(0, 3);
    if (matches.length === 0) return null;
    return `Filing rules for \`${topLevel}/\`:\n${matches.join("\n")}\n\n(Full rules: read resource \`vault://CLAUDE.md\`.)`;
  } catch {
    return null;
  }
}

export function registerVaultTools(
  server: McpServer,
  backend: StorageBackend,
): void {
  server.registerTool(
    "garden_read",
    {
      title: "Read Garden File",
      description:
        "Read a file from the Obsidian vault. Returns the full content including frontmatter.",
      inputSchema: {
        path: z
          .string()
          .describe("Relative path to the file (e.g. 'notes/my-note.md')"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path: filePath }) => {
      try {
        const content = await readVaultFile(backend, filePath);
        return { content: [{ type: "text", text: content }] };
      } catch (err: any) {
        return {
          content: [
            { type: "text", text: `Error reading file: ${err.message}` },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "garden_plant",
    {
      title: "Plant Garden File",
      description:
        "Write or overwrite a file in the Obsidian vault. Creates parent directories automatically. Use this to create new pages, update existing ones, or save any markdown content. This vault's filing conventions (folder structure, naming, frontmatter) are available via the `vault-rules` resource (CLAUDE.md) — check it before writing to an unfamiliar folder to avoid convention drift.",
      inputSchema: {
        path: z
          .string()
          .describe("Relative path for the file (e.g. 'notes/my-concept.md')"),
        content: z
          .string()
          .describe(
            "Full markdown content to write (including frontmatter if needed)",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path: filePath, content }) => {
      try {
        await writeVaultFile(backend, filePath, content);
        const hint = await getFilingHint(backend, filePath);
        const message = hint
          ? `Written: ${filePath}\n\n${hint}`
          : `Written: ${filePath}`;
        return {
          content: [{ type: "text", text: message }],
        };
      } catch (err: any) {
        return {
          content: [
            { type: "text", text: `Error writing file: ${err.message}` },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "garden_survey",
    {
      title: "Survey Garden",
      description:
        "List markdown files in the vault or a subdirectory. Returns relative paths.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Subdirectory to list (e.g. 'sources'). Omit for entire vault.",
          ),
        recursive: z
          .boolean()
          .optional()
          .default(true)
          .describe("Whether to list files in subdirectories (default: true)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path: subPath, recursive }) => {
      try {
        const files = await listVaultFiles(backend, subPath, recursive);
        if (files.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: subPath
                  ? `No markdown files found in ${subPath}/`
                  : "No markdown files found in vault.",
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `${files.length} files:\n${files.join("\n")}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            { type: "text", text: `Error listing files: ${err.message}` },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "garden_forage",
    {
      title: "Forage Garden",
      description:
        "Search the vault for files containing a text query. Returns matching files with line numbers and context. Case-insensitive.",
      inputSchema: {
        query: z.string().describe("Text to search for"),
        path: z
          .string()
          .optional()
          .describe("Subdirectory to limit search to (e.g. 'notes')"),
        maxResults: z
          .number()
          .optional()
          .default(20)
          .describe("Maximum number of matching files to return (default: 20)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, path: subPath, maxResults }) => {
      try {
        const results = await searchVault(backend, query, {
          subPath,
          maxResults,
        });
        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `No results for "${query}"` }],
          };
        }
        const output = results
          .map((r) => {
            const matchLines = r.matches
              .slice(0, 3)
              .map((m) => `  L${m.line}: ${m.text}`)
              .join("\n");
            return `${r.file} (${r.matches.length} matches)\n${matchLines}`;
          })
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: `${results.length} files match "${query}":\n\n${output}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error searching: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "garden_measure",
    {
      title: "Measure Garden",
      description:
        "Get vault statistics: file counts, folder structure, and whether the knowledge base has been initialized.",
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
        const stats = await getVaultStats(backend);
        return {
          content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting stats: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "garden_tag",
    {
      title: "Read Garden Tags",
      description:
        "Read the YAML frontmatter metadata from a vault file. Returns parsed key-value pairs (title, tags, date, status, etc.).",
      inputSchema: {
        path: z.string().describe("Relative path to the file"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path: filePath }) => {
      try {
        const content = await readVaultFile(backend, filePath);
        const fm = parseFrontmatter(content);
        if (Object.keys(fm).length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No frontmatter found in this file.",
              },
            ],
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(fm, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error reading frontmatter: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
