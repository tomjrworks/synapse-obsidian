import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type { StorageBackend } from "./utils/storage.js";
import { registerVaultTools } from "./tools/vault.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerInitTools } from "./tools/init.js";

function createServer(backend: StorageBackend): McpServer {
  const server = new McpServer({
    name: "synapse",
    version: "0.1.0",
  });
  registerVaultTools(server, backend);
  registerKnowledgeTools(server, backend);
  registerInitTools(server, backend);
  return server;
}

export async function startHttpServer(
  backend: StorageBackend,
  port: number,
): Promise<void> {
  const app = express();

  app.use(express.json());

  // Request logging
  app.use((req, res, next) => {
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

  // Bearer token auth (optional)
  const AUTH_TOKEN = process.env.SYNAPSE_AUTH_TOKEN || "";
  if (AUTH_TOKEN) {
    app.use("/mcp", (req, res, next) => {
      if (req.method === "OPTIONS") return next();
      const header = req.headers.authorization;
      if (header !== `Bearer ${AUTH_TOKEN}`) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      next();
    });
  }

  // Stateless MCP: each request gets a fresh transport + server
  // This avoids session ID issues with Claude.ai
  app.post("/mcp", async (req, res) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined as any, // stateless mode
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

  app.get("/mcp", async (_req, res) => {
    res
      .status(405)
      .json({ error: "SSE not supported in stateless mode. Use POST." });
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
