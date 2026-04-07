#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerVaultTools } from "./tools/vault.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerInitTools } from "./tools/init.js";
import { parseArgs } from "./utils/args.js";

const args = parseArgs();

const server = new McpServer({
  name: "synapse",
  version: "0.1.0",
});

registerVaultTools(server, args.vaultPath);
registerKnowledgeTools(server, args.vaultPath);
registerInitTools(server, args.vaultPath);

async function main() {
  if (args.mode === "http") {
    const { startHttpServer } = await import("./http.js");
    await startHttpServer(server, args.port);
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch((err) => {
  console.error("Synapse fatal error:", err);
  process.exit(1);
});
