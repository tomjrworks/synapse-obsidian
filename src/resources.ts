import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "./utils/storage.js";

export function registerResources(
  server: McpServer,
  backend: StorageBackend,
): void {
  server.registerResource(
    "vault-rules",
    "vault://CLAUDE.md",
    {
      title: "Vault Filing Rules",
      description:
        "Filing rules, folder structure, and writing conventions for this vault. Read before creating files to follow the vault's conventions (naming, folder placement, frontmatter, backlinks).",
      mimeType: "text/markdown",
    },
    async (uri) => {
      let text: string;
      try {
        if (await backend.exists("CLAUDE.md")) {
          text = await backend.readFile("CLAUDE.md");
        } else {
          text =
            "# No filing rules configured\n\nThis vault has no CLAUDE.md. Run `synapse_setup` and `synapse_configure` to generate one tailored to the vault's purpose and topics.";
        }
      } catch (err: any) {
        text = `Error reading CLAUDE.md: ${err.message}`;
      }
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "text/markdown",
            text,
          },
        ],
      };
    },
  );
}
