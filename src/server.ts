import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { StorageBackend } from "./utils/storage.js";
import { registerVaultTools } from "./tools/vault.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerInitTools } from "./tools/init.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import {
  registerOAuthRoutes,
  requireAuth,
  type AuthedMcpRequest,
} from "./oauth.js";
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

export async function startServer(port: number): Promise<void> {
  const app = express();

  // 10MB cap accommodates batched helper push payloads (up to 500 ops at
  // ~vault-note size). Verified safe globally including /mcp: grep over src/
  // for "413"/payloadTooLarge/content-length found no /mcp tool that depends
  // on the default 100KB cap as backpressure (plan T11.3 §11.1).
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));

  // Add new credential-equivalent keys here; replacer applies at every nesting level.
  const SENSITIVE_BODY_KEYS = new Set([
    "password",
    "code_verifier",
    "client_secret",
    "refresh_token",
    "access_token",
    "bearer",
    "jwt",
    "token",
    "code",
  ]);

  app.use((req, _res, next) => {
    let body = "";
    if (req.body) {
      body = JSON.stringify(req.body, (key, value) =>
        SENSITIVE_BODY_KEYS.has(key) ? "[redacted]" : value,
      ).slice(0, 300);
    }
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

  mountApiRoutes(app);
  console.error(`[API] Onboarding endpoints mounted at /api/*`);

  app.post("/mcp", async (req, res) => {
    if (await requireAuth(req, res)) return;
    try {
      const { workspaceId } = req as AuthedMcpRequest;
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
    if (await requireAuth(req, res)) return;
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
