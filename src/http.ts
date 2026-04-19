import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type { StorageBackend } from "./utils/storage.js";
import { registerVaultTools } from "./tools/vault.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerInitTools } from "./tools/init.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { registerOAuthRoutes, requireAuth } from "./oauth.js";

function createServer(backend: StorageBackend): McpServer {
  const server = new McpServer({
    name: "synapse",
    version: "0.1.0",
  });
  registerVaultTools(server, backend);
  registerKnowledgeTools(server, backend);
  registerInitTools(server, backend);
  registerPrompts(server, backend);
  registerResources(server, backend);
  return server;
}

export async function startHttpServer(
  backend: StorageBackend,
  port: number,
): Promise<void> {
  const app = express();

  // Parse both JSON and URL-encoded bodies (OAuth forms use URL-encoded)
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Request logging
  app.use((req, _res, next) => {
    const body = req.body ? JSON.stringify(req.body).slice(0, 300) : "";
    console.error(
      `[${new Date().toISOString()}] ${req.method} ${req.path} body=${body}`,
    );
    next();
  });

  // CORS
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

  // OAuth: auto-generate password for HTTP mode if not set
  const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
  if (!process.env.SYNAPSE_PASSWORD) {
    const { randomBytes } = await import("node:crypto");
    const generated = randomBytes(6).toString("hex").match(/.{4}/g)!.join("-");
    process.env.SYNAPSE_PASSWORD = generated;
    console.error(`\n  Your Synapse password: ${generated}`);
    console.error(
      `  (needed when connecting from Claude.ai or other remote clients)\n`,
    );
  }
  registerOAuthRoutes(app, baseUrl);
  console.error(`[OAuth] Enabled. Password protected.`);

  // MCP endpoint — stateless, one transport per request
  app.post("/mcp", async (req, res) => {
    // Check auth if enabled
    if (requireAuth(req, res)) return;

    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined as any,
      });
      const server = createServer(backend);
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

  // Health check
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: "synapse",
      version: "0.1.0",
    });
  });

  app.listen(port, () => {
    console.error(`Synapse MCP server running at http://localhost:${port}/mcp`);
  });
}
