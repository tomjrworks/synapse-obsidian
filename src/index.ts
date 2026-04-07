#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerVaultTools } from "./tools/vault.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerInitTools } from "./tools/init.js";
import { LocalBackend } from "./utils/storage.js";
import { parseArgs } from "./utils/args.js";

const args = parseArgs();

async function main() {
  if (args.mode === "cloud") {
    // Cloud mode: Google Drive OAuth, no local vault needed
    const { startCloudServer } = await import("./cloud.js");
    await startCloudServer(args.port);
  } else {
    // Local mode: filesystem backend
    const backend = new LocalBackend(args.vaultPath);

    const server = new McpServer({
      name: "synapse",
      version: "0.1.0",
    });

    registerVaultTools(server, backend);
    registerKnowledgeTools(server, backend);
    registerInitTools(server, backend);

    if (args.mode === "http") {
      const { startHttpServer } = await import("./http.js");
      await startHttpServer(server, args.port);
    } else {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    }
  }
}

main().catch((err) => {
  console.error("Synapse fatal error:", err);
  process.exit(1);
});
