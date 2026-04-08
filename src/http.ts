import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
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

  // CORS for browser-based clients (must be before routes)
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

  app.use(express.json());

  // Bearer token auth
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

  // Store transports by session ID
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // MCP endpoint
  app.post("/mcp", async (req, res) => {
    const sessionId = (req.headers["mcp-session-id"] as string) || undefined;

    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else {
      // New session — new server instance per connection
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        const sid = (transport as any).sessionId;
        if (sid) transports.delete(sid);
      };

      const server = createServer(backend);
      await server.connect(transport);

      const newSessionId = (transport as any).sessionId;
      if (newSessionId) {
        transports.set(newSessionId, transport);
      }
    }

    await transport.handleRequest(req, res, req.body);
  });

  // GET for SSE stream (Streamable HTTP spec)
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  // DELETE for session cleanup
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.close();
      transports.delete(sessionId);
    }
    res.status(200).json({ ok: true });
  });

  // Health check
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: "synapse",
      version: "0.1.0",
      sessions: transports.size,
    });
  });

  app.listen(port, () => {
    console.error(`Synapse MCP server running at http://localhost:${port}/mcp`);
    console.error(`Health check: http://localhost:${port}/health`);
  });
}
