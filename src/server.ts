import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request } from "express";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { StorageBackend } from "./utils/storage.js";
import { registerVaultTools } from "./tools/vault.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerInitTools } from "./tools/init.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { registerOAuthRoutes, requireAuth } from "./oauth.js";
import { mountApiRoutes } from "./api/routes.js";
import { getBackend } from "./utils/backend-cache.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "../package.json"), "utf-8"),
);

function createMcpServer(backend: StorageBackend): McpServer {
  const server = new McpServer({
    name: "taproot",
    version: pkg.version,
  });
  registerVaultTools(server, backend);
  registerKnowledgeTools(server, backend);
  registerInitTools(server, backend);
  registerPrompts(server, backend);
  registerResources(server, backend);
  return server;
}

// T6.1 placeholder. Reads OWNER_WORKSPACE_ID from env. T6.4 swaps this for
// req.workspaceId populated by the workspace-aware requireAuth.
function resolveWorkspaceId(_req: Request): string {
  const id = process.env.OWNER_WORKSPACE_ID;
  if (!id) {
    throw new Error(
      "OWNER_WORKSPACE_ID env var required (T6.1 single-workspace placeholder)",
    );
  }
  return id;
}

export async function startServer(
  backend: StorageBackend,
  port: number,
): Promise<void> {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use((req, _res, next) => {
    const body = req.body ? JSON.stringify(req.body).slice(0, 300) : "";
    console.error(
      `[${new Date().toISOString()}] ${req.method} ${req.path} body=${body}`,
    );
    next();
  });

  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, mcp-session-id, Authorization",
    );
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    next();
  });
  app.options("/mcp", (_req, res) => res.sendStatus(204));

  const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
  registerOAuthRoutes(app, baseUrl);
  console.error(
    `[OAuth] Enabled. Sign in with your Taproot account (taproothq.com).`,
  );

  mountApiRoutes(app, backend);
  console.error(`[API] Onboarding endpoints mounted at /api/*`);

  app.post("/mcp", async (req, res) => {
    if (requireAuth(req, res)) return;
    try {
      // T6.1: route to the workspace-scoped encrypted mirror. The startServer
      // `backend` argument is still used by /api/* (firstWowRouter writes the
      // first-wow note to the local helper-managed vault); /mcp is the path
      // that goes through Supabase. Two writers, two paths, intentional.
      const workspaceId = resolveWorkspaceId(req);
      const mcpBackend = await getBackend(workspaceId);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined as any,
      });
      const server = createMcpServer(mcpBackend);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err: any) {
      console.error(`[${new Date().toISOString()}] ERROR: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  });

  app.get("/mcp", async (req, res) => {
    if (requireAuth(req, res)) return;
    res.status(405).json({ error: "Use POST" });
  });

  app.delete("/mcp", async (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: "taproot",
      version: pkg.version,
    });
  });

  app.listen(port, () => {
    console.error(`Taproot server running at http://localhost:${port}`);
    console.error(`  MCP:    POST /mcp`);
    console.error(`  API:    /api/*`);
    console.error(`  Health: GET  /health`);
  });
}
