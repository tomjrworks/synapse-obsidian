import path from "node:path";
import fs from "node:fs";

export interface SynapseArgs {
  vaultPath: string;
  mode: "stdio" | "http";
  port: number;
}

export function parseArgs(): SynapseArgs {
  const args = process.argv.slice(2);
  let vaultPath = "";
  let mode: "stdio" | "http" = "stdio";
  let port = 3777;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--http") {
      mode = "http";
    } else if (arg === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (!arg.startsWith("--")) {
      vaultPath = arg;
    }
  }

  if (!vaultPath) {
    // Check env var
    vaultPath = process.env.SYNAPSE_VAULT_PATH || "";
  }

  if (!vaultPath) {
    console.error(
      "Usage: synapse <vault-path> [--http] [--port 3777]\n\n" +
        "  <vault-path>  Path to your Obsidian vault\n" +
        "  --http        Start HTTP server (for Claude.ai remote MCP)\n" +
        "  --port N      HTTP port (default: 3777)\n\n" +
        "Or set SYNAPSE_VAULT_PATH environment variable.",
    );
    process.exit(1);
  }

  // Resolve to absolute path
  vaultPath = path.resolve(vaultPath);

  if (!fs.existsSync(vaultPath)) {
    console.error(`Vault path does not exist: ${vaultPath}`);
    process.exit(1);
  }

  if (!fs.statSync(vaultPath).isDirectory()) {
    console.error(`Vault path is not a directory: ${vaultPath}`);
    process.exit(1);
  }

  return { vaultPath, mode, port };
}
