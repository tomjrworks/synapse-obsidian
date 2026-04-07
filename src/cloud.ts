import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { google } from "googleapis";
import { randomUUID } from "node:crypto";
import express from "express";
import { GoogleDriveBackend } from "./utils/google-drive.js";
import { registerVaultTools } from "./tools/vault.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerInitTools } from "./tools/init.js";

interface UserSession {
  accessToken: string;
  refreshToken?: string;
  folderId: string;
  folderName: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const BASE_URL = process.env.BASE_URL || "http://localhost:3777";

function getOAuth2Client() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    `${BASE_URL}/auth/callback`,
  );
}

export async function startCloudServer(port: number): Promise<void> {
  const app = express();

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
  app.options("/{*splat}", (_req, res) => res.sendStatus(204));

  app.use(express.json());

  // Session storage (in-memory for v1, database for v2)
  const sessions = new Map<string, UserSession>();
  // Map OAuth state to pending session info
  const pendingAuth = new Map<string, { createdAt: number }>();

  // --- OAuth Flow ---

  // Step 1: User visits this to start OAuth
  app.get("/auth/google", (_req, res) => {
    const oauth2Client = getOAuth2Client();
    const state = randomUUID();
    pendingAuth.set(state, { createdAt: Date.now() });

    // Clean up old pending auths (>10 min)
    for (const [key, val] of pendingAuth) {
      if (Date.now() - val.createdAt > 600000) {
        pendingAuth.delete(key);
      }
    }

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: [
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/drive.readonly",
      ],
      state,
      prompt: "consent",
    });

    res.redirect(authUrl);
  });

  // Step 2: Google redirects back here
  app.get("/auth/callback", async (req, res) => {
    const { code, state } = req.query;

    if (!code || !state || !pendingAuth.has(state as string)) {
      res.status(400).send("Invalid OAuth callback");
      return;
    }

    pendingAuth.delete(state as string);

    try {
      const oauth2Client = getOAuth2Client();
      const { tokens } = await oauth2Client.getToken(code as string);

      if (!tokens.access_token) {
        res.status(400).send("No access token received");
        return;
      }

      // Create a temporary session token
      const sessionToken = randomUUID();

      // Store tokens temporarily for folder picker
      sessions.set(sessionToken, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || undefined,
        folderId: "",
        folderName: "",
        transport: null as any,
        server: null as any,
      });

      // Redirect to folder picker
      res.redirect(`/pick-folder?session=${sessionToken}`);
    } catch (err: any) {
      res.status(500).send(`OAuth error: ${err.message}`);
    }
  });

  // Step 3: Folder picker page
  app.get("/pick-folder", async (req, res) => {
    const sessionToken = req.query.session as string;
    const session = sessions.get(sessionToken);

    if (!session) {
      res.status(400).send("Invalid session");
      return;
    }

    // List top-level folders in Drive
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({
      access_token: session.accessToken,
    });
    const drive = google.drive({
      version: "v3",
      auth: oauth2Client,
    });

    try {
      const result = await drive.files.list({
        q: "mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false",
        fields: "files(id, name)",
        pageSize: 100,
        orderBy: "name",
      });

      const folders = result.data.files || [];

      const folderList = folders
        .map(
          (f) =>
            `<li><a href="/select-folder?session=${sessionToken}&folderId=${f.id}&folderName=${encodeURIComponent(f.name || "")}">${f.name}</a></li>`,
        )
        .join("\n");

      res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Synapse — Select Your Vault</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; color: #1a1a1a; }
    h1 { font-size: 24px; }
    p { color: #666; line-height: 1.6; }
    ul { list-style: none; padding: 0; }
    li { margin: 8px 0; }
    a { display: block; padding: 12px 16px; background: #f5f5f5; border-radius: 8px; color: #1a1a1a; text-decoration: none; font-size: 16px; }
    a:hover { background: #e8e8e8; }
    .folder-icon { margin-right: 8px; }
  </style>
</head>
<body>
  <h1>Select your Obsidian vault folder</h1>
  <p>Choose the Google Drive folder that contains your Obsidian vault:</p>
  <ul>
    ${folderList || "<li>No folders found in Google Drive root.</li>"}
  </ul>
  <p style="margin-top: 24px; font-size: 14px; color: #999;">Only showing top-level folders. Make sure your vault is synced to Google Drive.</p>
</body>
</html>`);
    } catch (err: any) {
      res.status(500).send(`Error listing folders: ${err.message}`);
    }
  });

  // Step 4: User selects a folder
  app.get("/select-folder", async (req, res) => {
    const sessionToken = req.query.session as string;
    const folderId = req.query.folderId as string;
    const folderName = decodeURIComponent(
      (req.query.folderName as string) || "vault",
    );

    const session = sessions.get(sessionToken);
    if (!session || !folderId) {
      res.status(400).send("Invalid session or folder");
      return;
    }

    // Set up the MCP server with Google Drive backend
    const backend = new GoogleDriveBackend(session.accessToken, folderId);

    const server = new McpServer({
      name: "synapse",
      version: "0.1.0",
    });

    registerVaultTools(server, backend);
    registerKnowledgeTools(server, backend);
    registerInitTools(server, backend);

    // Update session
    session.folderId = folderId;
    session.folderName = folderName;
    session.server = server;

    const mcpUrl = `${BASE_URL}/mcp/${sessionToken}`;

    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Synapse — Connected!</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; color: #1a1a1a; }
    h1 { font-size: 24px; color: #16a34a; }
    .url-box { background: #f5f5f5; border-radius: 8px; padding: 16px; font-family: monospace; font-size: 14px; word-break: break-all; margin: 16px 0; cursor: pointer; }
    .url-box:hover { background: #e8e8e8; }
    .steps { line-height: 1.8; }
    .steps li { margin: 8px 0; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 4px; font-size: 14px; }
  </style>
  <script>
    function copyUrl() {
      navigator.clipboard.writeText('${mcpUrl}');
      document.getElementById('copied').style.display = 'inline';
    }
  </script>
</head>
<body>
  <h1>Connected to "${folderName}"</h1>
  <p>Your Synapse MCP server is ready. Copy this URL and add it to Claude.ai:</p>

  <div class="url-box" onclick="copyUrl()">
    ${mcpUrl}
    <span id="copied" style="display:none; color: #16a34a; margin-left: 8px;">Copied!</span>
  </div>

  <h3>How to connect in Claude.ai:</h3>
  <ol class="steps">
    <li>Go to <strong>Claude.ai</strong></li>
    <li>Open <strong>Settings</strong> > <strong>Integrations</strong></li>
    <li>Click <strong>"Add Custom Integration"</strong></li>
    <li>Paste the URL above</li>
    <li>Done — Claude now has access to your vault</li>
  </ol>

  <p style="margin-top: 24px; font-size: 14px; color: #999;">
    Available tools: vault_read, vault_write, vault_list, vault_search, vault_stats, vault_frontmatter, kb_init, kb_ingest, kb_compile, kb_query, kb_lint
  </p>
</body>
</html>`);
  });

  // --- MCP Endpoint (per-session) ---

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp/:sessionToken", async (req, res) => {
    const { sessionToken } = req.params;
    const session = sessions.get(sessionToken);

    if (!session || !session.server) {
      res.status(401).json({
        error: "Invalid session. Visit /auth/google to connect your vault.",
      });
      return;
    }

    const mcpSessionId = (req.headers["mcp-session-id"] as string) || undefined;
    let transport: StreamableHTTPServerTransport;

    const transportKey = `${sessionToken}:${mcpSessionId || "new"}`;

    if (mcpSessionId && transports.has(transportKey)) {
      transport = transports.get(transportKey)!;
    } else {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        transports.delete(transportKey);
      };

      await session.server.connect(transport);

      const newKey = `${sessionToken}:${(transport as any).sessionId}`;
      transports.set(newKey, transport);
    }

    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp/:sessionToken", async (req, res) => {
    const { sessionToken } = req.params;
    const mcpSessionId = req.headers["mcp-session-id"] as string;
    const transportKey = `${sessionToken}:${mcpSessionId}`;
    const transport = transports.get(transportKey);

    if (!transport) {
      res.status(400).json({ error: "Invalid session" });
      return;
    }

    await transport.handleRequest(req, res);
  });

  app.delete("/mcp/:sessionToken", async (req, res) => {
    const { sessionToken } = req.params;
    const mcpSessionId = req.headers["mcp-session-id"] as string;
    const transportKey = `${sessionToken}:${mcpSessionId}`;

    if (transports.has(transportKey)) {
      const transport = transports.get(transportKey)!;
      await transport.close();
      transports.delete(transportKey);
    }

    res.status(200).json({ ok: true });
  });

  // --- Health & Landing ---

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: "synapse-cloud",
      version: "0.1.0",
      activeSessions: sessions.size,
    });
  });

  app.get("/", (_req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Synapse — Connect Your Obsidian Vault to Claude</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 80px auto; padding: 0 20px; color: #1a1a1a; text-align: center; }
    h1 { font-size: 32px; margin-bottom: 8px; }
    .subtitle { color: #666; font-size: 18px; margin-bottom: 40px; }
    .connect-btn { display: inline-block; padding: 16px 32px; background: #1a1a1a; color: white; text-decoration: none; border-radius: 8px; font-size: 18px; font-weight: 500; }
    .connect-btn:hover { background: #333; }
    .features { text-align: left; margin: 40px 0; line-height: 1.8; }
    .features li { margin: 8px 0; }
  </style>
</head>
<body>
  <h1>Synapse</h1>
  <p class="subtitle">Connect your Obsidian vault to Claude.ai</p>

  <a href="/auth/google" class="connect-btn">Connect with Google Drive</a>

  <ul class="features">
    <li><strong>Zero install</strong> — works from your phone, laptop, anywhere</li>
    <li><strong>Knowledge base tools</strong> — ingest, compile, query, lint</li>
    <li><strong>Your vault stays in Drive</strong> — syncs to all your devices</li>
    <li><strong>11 AI tools</strong> — Claude reads, writes, and maintains your wiki</li>
  </ul>

  <p style="font-size: 14px; color: #999; margin-top: 40px;">
    Open source — <a href="https://github.com/mainloop-systems/synapse-mcp" style="color: #666;">GitHub</a> |
    By <a href="https://mainloopsystems.com" style="color: #666;">MainLoop Systems</a>
  </p>
</body>
</html>`);
  });

  app.listen(port, () => {
    console.error(`Synapse Cloud running at ${BASE_URL}`);
    console.error(`Connect: ${BASE_URL}/auth/google`);
    console.error(`Health: ${BASE_URL}/health`);
  });
}
