import path from "node:path";
import fs from "node:fs";

export interface SynapseArgs {
  vaultPath: string;
  mode: "stdio" | "http" | "cloud";
  port: number;
}

export function parseArgs(): SynapseArgs {
  const args = process.argv.slice(2);
  let vaultPath = "";
  let mode: "stdio" | "http" | "cloud" = "stdio";
  let port = parseInt(process.env.PORT || "3777", 10);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--http") {
      mode = "http";
    } else if (arg === "--cloud") {
      mode = "cloud";
    } else if (arg === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (!arg.startsWith("--")) {
      vaultPath = arg;
    }
  }

  // Cloud mode doesn't need a vault path (users connect via OAuth)
  if (mode === "cloud") {
    return { vaultPath: "", mode, port };
  }

  if (!vaultPath) {
    vaultPath = process.env.SYNAPSE_VAULT_PATH || "";
  }

  if (!vaultPath) {
    console.error(
      "Usage: synapse <vault-path> [--http] [--port 3777]\n" +
        "       synapse --cloud [--port 3777]\n\n" +
        "  <vault-path>  Path to your Obsidian vault\n" +
        "  --http        Start HTTP server (for Claude.ai remote MCP)\n" +
        "  --cloud       Start hosted cloud server (Google Drive OAuth)\n" +
        "  --port N      HTTP port (default: 3777)\n\n" +
        "Or set SYNAPSE_VAULT_PATH environment variable.",
    );
    process.exit(1);
  }

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
