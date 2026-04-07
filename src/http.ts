import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import express from "express";

export async function startHttpServer(
  server: McpServer,
  port: number,
): Promise<void> {
  const app = express();

  // CORS for browser-based clients (must be before routes)
  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    next();
  });
  app.options("/mcp", (_req, res) => res.sendStatus(204));

  app.use(express.json());

  // Store transports by session ID
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // MCP endpoint
  app.post("/mcp", async (req, res) => {
    const sessionId = (req.headers["mcp-session-id"] as string) || undefined;

    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else {
      // New session
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        const sid = (transport as any).sessionId;
        if (sid) transports.delete(sid);
      };

      await server.connect(transport);

      // Store after connection so sessionId is set
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
    console.error(`Press Ctrl+C to stop`);
  });
}
