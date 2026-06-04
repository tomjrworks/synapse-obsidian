#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerVaultTools } from "./tools/vault.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerGardenPrimitives } from "./tools/garden-primitives.js";
import { registerInitTools } from "./tools/init.js";
import { registerRulesTool } from "./tools/rules.js";
import { registerIndexTool } from "./tools/index-tool.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { LocalBackend } from "./utils/storage.js";
import { parseArgs } from "./utils/args.js";
import { printBanner } from "./banner.js";
import { assembleInstructions } from "./utils/instructions.js";

printBanner();
const args = parseArgs();

async function main() {
  if (args.mode === "http") {
    const { startServer } = await import("./server.js");
    await startServer(args.port);
  } else {
    const backend = new LocalBackend(args.vaultPath);
    const instructions = await assembleInstructions(backend);
    const server = new McpServer(
      {
        name: "taproot",
        version: "0.4.0",
      },
      { instructions },
    );

    registerVaultTools(server, backend);
    registerKnowledgeTools(server, backend);
    registerGardenPrimitives(server, backend);
    registerInitTools(server, backend);
    registerRulesTool(server, backend);
    registerIndexTool(server, backend);
    registerPrompts(server, backend);
    registerResources(server, backend);

    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch((err) => {
  console.error("Taproot fatal error:", err);
  process.exit(1);
});
