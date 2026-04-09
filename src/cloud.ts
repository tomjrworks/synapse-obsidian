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
  app.use(express.urlencoded({ extended: true }));

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

  // Shared page styles (MainLoop branded)
  const pageStyles = `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #F2F0EB;
      color: #3D3529;
      min-height: 100vh;
      padding: 60px 20px;
    }
    .container { max-width: 640px; margin: 0 auto; }
    .logo { font-size: 18px; font-weight: 700; margin-bottom: 4px; display: flex; align-items: center; gap: 8px; }
    .logo-dot { width: 8px; height: 8px; background: #2ECC71; border-radius: 50%; }
    .by { font-size: 12px; color: #8B9490; margin-bottom: 32px; font-family: monospace; text-transform: uppercase; letter-spacing: 0.15em; }
    h1 { font-family: Georgia, serif; font-size: 28px; font-weight: 400; margin-bottom: 8px; }
    .subtitle { color: #8B9490; font-size: 15px; margin-bottom: 36px; line-height: 1.6; }
    .option-card {
      background: white;
      border: 1px solid rgba(61,53,41,0.08);
      border-radius: 10px;
      padding: 24px;
      margin-bottom: 12px;
      cursor: pointer;
      text-decoration: none;
      display: block;
      color: inherit;
      transition: all 0.2s;
    }
    .option-card:hover { border-color: rgba(26,92,50,0.3); transform: translateY(-1px); box-shadow: 0 4px 12px rgba(61,53,41,0.06); }
    .option-card h3 { font-size: 16px; font-weight: 600; margin-bottom: 4px; }
    .option-card p { font-size: 14px; color: #8B9490; line-height: 1.5; }
    .option-card .tag { display: inline-block; font-size: 11px; font-family: monospace; text-transform: uppercase; letter-spacing: 0.1em; padding: 3px 8px; border-radius: 4px; margin-bottom: 8px; }
    .tag-quick { background: rgba(46,204,113,0.1); color: #1A5C32; }
    .tag-existing { background: rgba(61,53,41,0.06); color: #8B9490; }
    .tag-power { background: rgba(26,92,50,0.08); color: #1A5C32; }
    .folder-list { list-style: none; padding: 0; max-height: 400px; overflow-y: auto; }
    .folder-list li { margin: 6px 0; }
    .folder-list a {
      display: block;
      padding: 12px 16px;
      background: white;
      border: 1px solid rgba(61,53,41,0.08);
      border-radius: 8px;
      color: #3D3529;
      text-decoration: none;
      font-size: 15px;
      transition: all 0.15s;
    }
    .folder-list a:hover { border-color: rgba(26,92,50,0.3); background: rgba(26,92,50,0.02); }
    .back-link { display: inline-block; margin-bottom: 24px; color: #8B9490; text-decoration: none; font-size: 14px; }
    .back-link:hover { color: #3D3529; }
    input[type=text] {
      width: 100%;
      padding: 14px 16px;
      border: 1px solid rgba(61,53,41,0.15);
      border-radius: 6px;
      font-size: 15px;
      margin-bottom: 12px;
      background: white;
      color: #3D3529;
      outline: none;
    }
    input[type=text]:focus { border-color: #1A5C32; }
    input[type=text]::placeholder { color: #8B9490; }
    .btn {
      display: inline-block;
      padding: 14px 28px;
      background: #1A5C32;
      color: #F2F0EB;
      border: none;
      border-radius: 6px;
      font-size: 13px;
      font-family: monospace;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      cursor: pointer;
      transition: all 0.2s;
      text-decoration: none;
    }
    .btn:hover { background: #16472a; transform: translateY(-1px); }
    .check-list { list-style: none; padding: 0; margin: 16px 0; }
    .check-list li { padding: 6px 0; font-size: 14px; color: #8B9490; display: flex; align-items: center; gap: 8px; }
    .check-list li::before { content: ''; width: 6px; height: 6px; background: #2ECC71; border-radius: 50%; flex-shrink: 0; }
    .note { font-size: 13px; color: #8B9490; margin-top: 20px; line-height: 1.6; }
  `;

  const pageHeader = `
    <div class="logo"><span class="logo-dot"></span> Synapse</div>
    <div class="by">by Main Loop Systems</div>
  `;

  // Step 3: Onboarding — choose how to set up vault
  app.get("/pick-folder", async (req, res) => {
    const sessionToken = req.query.session as string;
    const session = sessions.get(sessionToken);

    if (!session) {
      res.status(400).send("Invalid session");
      return;
    }

    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Synapse — Set Up Your Brain</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${pageStyles}</style>
</head>
<body>
  <div class="container">
    ${pageHeader}
    <h1>Set up your brain</h1>
    <p class="subtitle">Choose how you want to get started. Your files stay in Google Drive — Synapse just connects them to your AI.</p>

    <a href="/create-vault?session=${sessionToken}" class="option-card">
      <span class="tag tag-quick">Quick start</span>
      <h3>Create a new vault</h3>
      <p>Start fresh. We'll create a "Synapse" folder in your Drive with a ready-to-use structure.</p>
    </a>

    <a href="/browse-folders?session=${sessionToken}" class="option-card">
      <span class="tag tag-existing">Existing notes</span>
      <h3>Use an existing folder</h3>
      <p>Already have notes in Google Drive? Pick the folder and Synapse adapts to your structure.</p>
    </a>

    <a href="/condense-folders?session=${sessionToken}" class="option-card">
      <span class="tag tag-power">Consolidate</span>
      <h3>Combine scattered folders</h3>
      <p>Notes spread across multiple Drive folders? We'll gather them into one vault without deleting anything.</p>
    </a>
  </div>
</body>
</html>`);
  });

  // Option 1: Create a new vault folder
  app.get("/create-vault", async (req, res) => {
    const sessionToken = req.query.session as string;
    const session = sessions.get(sessionToken);

    if (!session) {
      res.status(400).send("Invalid session");
      return;
    }

    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Synapse — Create Vault</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${pageStyles}</style>
</head>
<body>
  <div class="container">
    ${pageHeader}
    <a href="/pick-folder?session=${sessionToken}" class="back-link">&larr; Back</a>
    <h1>Create a new vault</h1>
    <p class="subtitle">We'll create a folder in your Google Drive with a starter structure for your knowledge base.</p>

    <form method="POST" action="/create-vault">
      <input type="hidden" name="session" value="${sessionToken}">
      <input type="text" name="vaultName" placeholder="Vault name (e.g. My Brain, Research, Work)" value="Synapse" autofocus>
      <ul class="check-list">
        <li>Creates a folder in your Drive root</li>
        <li>Adds a welcome note and starter structure</li>
        <li>Ready to use immediately with Claude</li>
      </ul>
      <button type="submit" class="btn">Create Vault</button>
    </form>
  </div>
</body>
</html>`);
  });

  app.post("/create-vault", async (req, res) => {
    const { session: sessionToken, vaultName } = req.body || {};
    const session = sessions.get(sessionToken);

    if (!session) {
      res.status(400).send("Invalid session");
      return;
    }

    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({ access_token: session.accessToken });
    const drive = google.drive({ version: "v3", auth: oauth2Client });

    try {
      const name = vaultName || "Synapse";

      // Create the vault folder
      const folder = await drive.files.create({
        requestBody: {
          name,
          mimeType: "application/vnd.google-apps.folder",
        },
        fields: "id",
      });

      const folderId = folder.data.id!;

      // Create a welcome note
      await drive.files.create({
        requestBody: {
          name: "Welcome to Synapse.md",
          parents: [folderId],
          mimeType: "text/markdown",
        },
        media: {
          mimeType: "text/markdown",
          body: `# Welcome to ${name}\n\nThis is your AI-powered knowledge base. Start by telling Claude:\n\n> "Save this article: [paste any URL]"\n\n> "What do my notes say about [topic]?"\n\n> "Help me organize my vault"\n\nEvery note you save and every answer Claude gives compounds into a smarter brain over time.\n`,
        },
      });

      // Redirect to the success page
      res.redirect(
        `/select-folder?session=${sessionToken}&folderId=${folderId}&folderName=${encodeURIComponent(name)}`,
      );
    } catch (err: any) {
      res.status(500).send(`Error creating vault: ${err.message}`);
    }
  });

  // Option 2: Browse existing folders
  app.get("/browse-folders", async (req, res) => {
    const sessionToken = req.query.session as string;
    const parentId = (req.query.parentId as string) || "root";
    const parentName = decodeURIComponent(
      (req.query.parentName as string) || "Google Drive",
    );
    const session = sessions.get(sessionToken);

    if (!session) {
      res.status(400).send("Invalid session");
      return;
    }

    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({ access_token: session.accessToken });
    const drive = google.drive({ version: "v3", auth: oauth2Client });

    try {
      const result = await drive.files.list({
        q: `mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`,
        fields: "files(id, name)",
        pageSize: 100,
        orderBy: "name",
      });

      const folders = result.data.files || [];

      const folderList = folders
        .map(
          (f) => `<li>
            <a href="/browse-folders?session=${sessionToken}&parentId=${f.id}&parentName=${encodeURIComponent(f.name || "")}">
              ${f.name}
              <span style="float:right;color:#8B9490;font-size:13px;">browse &rarr;</span>
            </a>
          </li>`,
        )
        .join("\n");

      const selectCurrentBtn =
        parentId !== "root"
          ? `<a href="/select-folder?session=${sessionToken}&folderId=${parentId}&folderName=${encodeURIComponent(parentName)}" class="btn" style="margin-bottom:24px;">Use "${parentName}" as my vault</a>`
          : "";

      const backLink =
        parentId === "root"
          ? `<a href="/pick-folder?session=${sessionToken}" class="back-link">&larr; Back</a>`
          : `<a href="javascript:history.back()" class="back-link">&larr; Back</a>`;

      res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Synapse — Browse Folders</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${pageStyles}</style>
</head>
<body>
  <div class="container">
    ${pageHeader}
    ${backLink}
    <h1>${parentId === "root" ? "Choose a folder" : parentName}</h1>
    <p class="subtitle">${parentId === "root" ? "Navigate to the folder you want to use as your vault." : "Select this folder or browse deeper."}</p>
    ${selectCurrentBtn}
    <ul class="folder-list">
      ${folderList || "<li style='padding:12px;color:#8B9490;'>No subfolders found.</li>"}
    </ul>
  </div>
</body>
</html>`);
    } catch (err: any) {
      res.status(500).send(`Error listing folders: ${err.message}`);
    }
  });

  // Option 3: Condense scattered folders into one vault
  app.get("/condense-folders", async (req, res) => {
    const sessionToken = req.query.session as string;
    const session = sessions.get(sessionToken);

    if (!session) {
      res.status(400).send("Invalid session");
      return;
    }

    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({ access_token: session.accessToken });
    const drive = google.drive({ version: "v3", auth: oauth2Client });

    try {
      const result = await drive.files.list({
        q: "mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false",
        fields: "files(id, name)",
        pageSize: 100,
        orderBy: "name",
      });

      const folders = result.data.files || [];

      const checkboxes = folders
        .map(
          (f) => `<label class="folder-check">
            <input type="checkbox" name="folderIds" value="${f.id}" data-name="${f.name}">
            <span>${f.name}</span>
          </label>`,
        )
        .join("\n");

      res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Synapse — Consolidate Folders</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    ${pageStyles}
    .folder-check {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      background: white;
      border: 1px solid rgba(61,53,41,0.08);
      border-radius: 8px;
      margin-bottom: 6px;
      cursor: pointer;
      font-size: 15px;
      transition: all 0.15s;
    }
    .folder-check:hover { border-color: rgba(26,92,50,0.3); }
    .folder-check input { width: 18px; height: 18px; accent-color: #1A5C32; }
    .folder-check span { flex: 1; }
  </style>
</head>
<body>
  <div class="container">
    ${pageHeader}
    <a href="/pick-folder?session=${sessionToken}" class="back-link">&larr; Back</a>
    <h1>Consolidate into one vault</h1>
    <p class="subtitle">Select the folders you want to combine. We'll copy their contents into a new vault folder — nothing gets deleted from the originals.</p>

    <form method="POST" action="/condense-folders">
      <input type="hidden" name="session" value="${sessionToken}">
      <input type="text" name="vaultName" placeholder="New vault name" value="Synapse" style="margin-bottom:16px;">
      <div style="margin-bottom:16px;">
        ${checkboxes || "<p style='color:#8B9490;'>No folders found in Google Drive root.</p>"}
      </div>
      <ul class="check-list">
        <li>Creates a new folder in your Drive</li>
        <li>Copies files from selected folders (originals untouched)</li>
        <li>Docs and Sheets converted to markdown</li>
        <li>Preserves subfolder structure</li>
      </ul>
      <button type="submit" class="btn">Consolidate &amp; Connect</button>
    </form>
  </div>
</body>
</html>`);
    } catch (err: any) {
      res.status(500).send(`Error: ${err.message}`);
    }
  });

  app.post("/condense-folders", async (req, res) => {
    const { session: sessionToken, vaultName, folderIds } = req.body || {};
    const session = sessions.get(sessionToken);

    if (!session) {
      res.status(400).send("Invalid session");
      return;
    }

    // folderIds can be a string (single) or array (multiple)
    const ids: string[] = Array.isArray(folderIds)
      ? folderIds
      : folderIds
        ? [folderIds]
        : [];

    if (ids.length === 0) {
      res
        .status(400)
        .send("No folders selected. Go back and pick at least one.");
      return;
    }

    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({ access_token: session.accessToken });
    const drive = google.drive({ version: "v3", auth: oauth2Client });

    try {
      const name = vaultName || "Synapse";

      // Create the vault folder
      const vaultFolder = await drive.files.create({
        requestBody: {
          name,
          mimeType: "application/vnd.google-apps.folder",
        },
        fields: "id",
      });

      const vaultId = vaultFolder.data.id!;

      // Copy contents from each selected folder
      for (const sourceFolderId of ids) {
        // Get source folder name
        const folderMeta = await drive.files.get({
          fileId: sourceFolderId,
          fields: "name",
        });
        const subfolderName = folderMeta.data.name || "folder";

        // Create a subfolder in the vault for this source
        const subfolder = await drive.files.create({
          requestBody: {
            name: subfolderName,
            parents: [vaultId],
            mimeType: "application/vnd.google-apps.folder",
          },
          fields: "id",
        });

        // List files in the source folder
        const files = await drive.files.list({
          q: `'${sourceFolderId}' in parents and trashed = false`,
          fields: "files(id, name, mimeType)",
          pageSize: 500,
        });

        // Copy each file
        for (const file of files.data.files || []) {
          if (file.mimeType === "application/vnd.google-apps.folder") continue; // skip nested folders for now

          if (
            file.mimeType === "application/vnd.google-apps.document" ||
            file.mimeType === "application/vnd.google-apps.spreadsheet"
          ) {
            // Export Google Docs/Sheets as markdown/CSV then save as .md
            const exportMime =
              file.mimeType === "application/vnd.google-apps.document"
                ? "text/plain"
                : "text/csv";
            const exported = await drive.files.export(
              { fileId: file.id!, mimeType: exportMime },
              { responseType: "text" },
            );

            await drive.files.create({
              requestBody: {
                name: `${file.name}.md`,
                parents: [subfolder.data.id!],
                mimeType: "text/markdown",
              },
              media: {
                mimeType: "text/markdown",
                body: `# ${file.name}\n\n${exported.data as string}`,
              },
            });
          } else {
            // Copy the file directly
            await drive.files.copy({
              fileId: file.id!,
              requestBody: {
                name: file.name!,
                parents: [subfolder.data.id!],
              },
            });
          }
        }
      }

      // Create welcome note
      await drive.files.create({
        requestBody: {
          name: "Welcome to Synapse.md",
          parents: [vaultId],
          mimeType: "text/markdown",
        },
        media: {
          mimeType: "text/markdown",
          body: `# Welcome to ${name}\n\nThis vault was created by consolidating your existing folders. Your original folders are untouched.\n\nStart by telling Claude:\n\n> "Run a health check on my vault"\n\n> "What's in my vault?"\n\n> "Help me organize these notes"\n`,
        },
      });

      res.redirect(
        `/select-folder?session=${sessionToken}&folderId=${vaultId}&folderName=${encodeURIComponent(name)}`,
      );
    } catch (err: any) {
      res.status(500).send(`Error consolidating: ${err.message}`);
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
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${pageStyles}
    .url-box {
      background: #0f1210;
      border-radius: 8px;
      padding: 16px 20px;
      font-family: monospace;
      font-size: 13px;
      word-break: break-all;
      margin: 16px 0;
      cursor: pointer;
      color: rgba(242,240,235,0.7);
      transition: all 0.15s;
    }
    .url-box:hover { background: #161b18; }
    .steps { list-style: none; counter-reset: step; padding: 0; }
    .steps li {
      counter-increment: step;
      padding: 10px 0;
      font-size: 15px;
      color: #3D3529;
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }
    .steps li::before {
      content: counter(step);
      width: 24px;
      height: 24px;
      background: rgba(26,92,50,0.1);
      color: #1A5C32;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 600;
      flex-shrink: 0;
    }
  </style>
  <script>
    function copyUrl() {
      navigator.clipboard.writeText('${mcpUrl}');
      const el = document.getElementById('copied');
      el.style.display = 'inline';
      setTimeout(() => el.style.display = 'none', 2000);
    }
  </script>
</head>
<body>
  <div class="container">
    ${pageHeader}
    <h1>Connected to "${folderName}"</h1>
    <p class="subtitle">Your brain is live. Copy the URL below and add it to Claude.ai to start using it.</p>

    <div class="url-box" onclick="copyUrl()">
      ${mcpUrl}
      <span id="copied" style="display:none; color: #2ECC71; margin-left: 8px;">Copied!</span>
    </div>

    <ol class="steps">
      <li>Go to <strong>Claude.ai</strong></li>
      <li>Open <strong>Settings</strong> &rarr; <strong>Integrations</strong></li>
      <li>Click <strong>"Add Custom Integration"</strong></li>
      <li>Paste the URL above</li>
      <li>Start chatting — Claude now has access to your vault</li>
    </ol>

    <p class="note">
      Try saying: "What's in my vault?" or "Save this article: [paste any URL]"
    </p>
  </div>
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
