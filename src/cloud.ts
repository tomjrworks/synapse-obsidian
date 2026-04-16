import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { google } from "googleapis";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { GoogleDriveBackend } from "./utils/google-drive.js";
import { registerVaultTools } from "./tools/vault.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import {
  registerInitTools,
  generateClaudeMd,
  INDEX_TEMPLATE,
} from "./tools/init.js";
import { registerPrompts } from "./prompts.js";

interface UserSession {
  accessToken: string;
  refreshToken?: string;
  folderId: string;
  folderName: string;
}

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "";
// GCP OAuth client IDs have the format `{project_number}-{hash}.apps.googleusercontent.com`.
// Extract the project number for Picker's setAppId, which Google requires to link
// the Picker grant to the backend OAuth client. Without this, drive.files.* on
// Picker-granted file IDs returns 404 "File not found" from the backend.
const GOOGLE_PROJECT_NUMBER = GOOGLE_CLIENT_ID.split("-")[0] || "";
const BASE_URL = process.env.BASE_URL || "http://localhost:3777";

function getOAuth2Client() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    `${BASE_URL}/auth/callback`,
  );
}

async function refreshSessionToken(session: UserSession): Promise<string> {
  const oauth2 = getOAuth2Client();
  oauth2.setCredentials({
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
  });
  const { token } = await oauth2.getAccessToken();
  if (!token) {
    throw new Error("Failed to refresh access token — user must re-auth");
  }
  session.accessToken = token;
  return token;
}

const VALID_PURPOSES = ["research", "business", "personal", "academic"];
const VALID_CLIENTS = ["claude", "chatgpt", "cursor", "other"];

/** Map cloud UI purpose values to synapse config purpose values */
function mapPurposeToConfig(
  cloudPurpose: string,
): "knowledge-base" | "business" | "academic" | "life-os" {
  switch (cloudPurpose) {
    case "research":
      return "knowledge-base";
    case "business":
      return "business";
    case "academic":
      return "academic";
    case "personal":
      return "life-os";
    default:
      return "life-os";
  }
}

function sanitizePurpose(val: string): string {
  return VALID_PURPOSES.includes(val) ? val : "personal";
}

function sanitizeClient(val: string): string {
  return VALID_CLIENTS.includes(val) ? val : "other";
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function startCloudServer(port: number): Promise<void> {
  const missing: string[] = [];
  if (!GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (!GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
  if (!GOOGLE_API_KEY) missing.push("GOOGLE_API_KEY");
  if (missing.length > 0) {
    throw new Error(
      `Cloud mode requires env vars: ${missing.join(", ")}. See .env.example for required values.`,
    );
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(
    readFileSync(resolve(__dirname, "../package.json"), "utf-8"),
  );
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
      scope: ["https://www.googleapis.com/auth/drive.file"],
      state,
      prompt: "consent",
    });

    res.redirect(authUrl);
  });

  // Step 2: Google redirects back here
  app.get("/auth/callback", async (req, res) => {
    const { code, state, error } = req.query;

    // User denied access or something went wrong at Google's end
    if (error || !code) {
      const denied = error === "access_denied";
      res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Synapse — ${denied ? "Access Denied" : "Connection Error"}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${pageStyles}</style>
</head>
<body>
  <div class="container">
    ${pageHeader}
    <h1>${denied ? "No worries" : "Something went wrong"}</h1>
    <p class="subtitle">${denied ? "Synapse needs access to your Google Drive to connect your notes. No data is stored on our servers — your files stay in Drive." : "Google returned an error. This is usually temporary."}</p>
    <a href="/auth/google" class="btn">Try Again</a>
    <p class="note" style="margin-top:24px;">${denied ? "We read your folders and create files only inside your chosen vault. You pick exactly which folder to connect." : `Error: ${escapeHtml(String(error || "no authorization code received"))}`}</p>
  </div>
</body>
</html>`);
      return;
    }

    if (!state || !pendingAuth.has(state as string)) {
      res
        .status(400)
        .send("Invalid OAuth callback — session expired. Please try again.");
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
      });

      // Redirect to folder picker
      res.redirect(`/pick-folder?session=${sessionToken}`);
    } catch (err: any) {
      res.status(500).type("text").send(`OAuth error: ${err.message}`);
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
    .name-sug {
      font-size: 12px;
      padding: 4px 10px;
      background: rgba(61,53,41,0.05);
      border: 1px solid rgba(61,53,41,0.1);
      border-radius: 20px;
      color: #8B9490;
      cursor: pointer;
      transition: all 0.15s;
    }
    .name-sug:hover { border-color: rgba(26,92,50,0.3); color: #1A5C32; }
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

    try {
      await refreshSessionToken(session);
    } catch (err: any) {
      res
        .status(401)
        .send(
          `Session expired — please <a href="/auth/google">sign in again</a>.`,
        );
      return;
    }

    const safeJs = (s: string) => JSON.stringify(s).replace(/</g, "\\u003c");

    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Synapse — Set Up Your Brain</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${pageStyles}</style>
  <script src="https://apis.google.com/js/api.js"></script>
</head>
<body>
  <div class="container">
    ${pageHeader}
    <h1>Set up your brain</h1>
    <p class="subtitle">Choose how you want to get started. Your files stay in Google Drive — Synapse just connects them to your AI.</p>

    <a href="/create-vault?session=${sessionToken}" class="option-card">
      <span class="tag tag-quick">Quick start</span>
      <h3>Create a new vault</h3>
      <p>Start fresh. We'll create a folder in your Drive with a welcome note — ready to use immediately.</p>
    </a>

    <a href="#" onclick="launchImportPicker(); return false;" class="option-card">
      <span class="tag tag-power">Import files</span>
      <h3>Import existing files</h3>
      <p>Pick individual files from your Drive and we'll copy them into a new Synapse vault. Your originals stay in place.</p>
    </a>
  </div>
  <script>
    const SESSION_TOKEN = ${safeJs(sessionToken)};
    const ACCESS_TOKEN = ${safeJs(session.accessToken)};
    const API_KEY = ${safeJs(GOOGLE_API_KEY)};
    const APP_ID = ${safeJs(GOOGLE_PROJECT_NUMBER)};

    let pickerReady = false;
    gapi.load("picker", { callback: function () { pickerReady = true; } });

    function launchImportPicker() {
      if (!pickerReady) {
        alert("Google Picker is still loading — try again in a moment.");
        return;
      }
      var vaultName = window.prompt("Name your new vault:", "My Brain");
      if (vaultName === null) return;
      vaultName = vaultName.trim() || "My Brain";

      // Files-only view: user can navigate INTO folders to find files,
      // but can only SELECT individual files. Folder picking under drive.file
      // doesn't grant child listing access, so we pick files directly.
      var view = new google.picker.DocsView()
        .setOwnedByMe(true)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(false);
      var picker = new google.picker.PickerBuilder()
        .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
        .setOAuthToken(ACCESS_TOKEN)
        .setDeveloperKey(API_KEY)
        .setAppId(APP_ID)
        .addView(view)
        .setCallback(function (data) { onImportPicked(data, vaultName); })
        .build();
      picker.setVisible(true);
    }

    function onImportPicked(data, vaultName) {
      if (data.action !== google.picker.Action.PICKED) return;
      var docs = data.docs || [];
      if (docs.length === 0) {
        alert("No files selected. Click Import again to try.");
        return;
      }
      var items = docs.map(function (d) {
        return {
          id: d.id,
          name: d.name,
          mimeType: d.mimeType,
          resourceKey: d.resourceKey || undefined,
        };
      });
      fetch("/import-vault", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionToken: SESSION_TOKEN,
          vaultName: vaultName,
          items: items,
        }),
      })
        .then(function (r) { return r.json(); })
        .then(function (json) {
          if (json.redirect) {
            window.location = json.redirect;
          } else {
            alert("Import failed: " + (json.error || "unknown"));
          }
        })
        .catch(function (err) {
          alert("Network error during import: " + err.message);
        });
    }
  </script>
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
      <input type="text" name="vaultName" placeholder="Name your vault" value="My Brain" autofocus>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;">
        <span class="name-sug" onclick="document.querySelector('input[name=vaultName]').value=this.textContent">My Brain</span>
        <span class="name-sug" onclick="document.querySelector('input[name=vaultName]').value=this.textContent">Research</span>
        <span class="name-sug" onclick="document.querySelector('input[name=vaultName]').value=this.textContent">Work Notes</span>
        <span class="name-sug" onclick="document.querySelector('input[name=vaultName]').value=this.textContent">Knowledge Base</span>
        <span class="name-sug" onclick="document.querySelector('input[name=vaultName]').value=this.textContent">Second Brain</span>
      </div>
      <ul class="check-list">
        <li>Creates a folder in your Drive root</li>
        <li>Adds a welcome note to get you started</li>
        <li>Ready to use immediately with Claude</li>
      </ul>
      <button type="submit" class="btn" id="submit-btn">Create Vault</button>
    </form>
    <script>
      document.querySelector('form').addEventListener('submit', function() {
        const btn = document.getElementById('submit-btn');
        btn.textContent = 'Creating...';
        btn.style.opacity = '0.6';
        btn.style.pointerEvents = 'none';
      });
    </script>
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

    try {
      await refreshSessionToken(session);
    } catch (err: any) {
      res
        .status(401)
        .send(
          `Session expired — please <a href="/auth/google">sign in again</a>.`,
        );
      return;
    }

    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({
      access_token: session.accessToken,
      refresh_token: session.refreshToken,
    });
    const drive = google.drive({ version: "v3", auth: oauth2Client });

    try {
      const name = vaultName || "My Brain";

      // Create the vault folder
      const folder = await drive.files.create({
        requestBody: {
          name,
          mimeType: "application/vnd.google-apps.folder",
        },
        fields: "id",
        supportsAllDrives: true,
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
        supportsAllDrives: true,
      });

      // Redirect to the success page — skip preview for new vaults (nothing to show)
      res.redirect(
        `/select-folder?session=${sessionToken}&folderId=${folderId}&folderName=${encodeURIComponent(name)}&source=create`,
      );
    } catch (err: any) {
      console.error(`[Create Vault] Error: ${err.message}`);
      res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Synapse — Error</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${pageStyles}</style>
</head>
<body>
  <div class="container">
    ${pageHeader}
    <h1>Something went wrong</h1>
    <p class="subtitle">${escapeHtml(err.message)}</p>
    <a href="javascript:history.back()" class="btn">Try Again</a>
  </div>
</body>
</html>`);
    }
  });

  // Import existing files — JSON POST from Google Picker file-multi-select.
  // Creates a new app-owned vault folder and copies each picked file into it.
  // drive.files.copy under drive.file works for: source=Picker-granted file,
  // destination=app-owned folder. The copies are app-owned so drive.file has
  // full access to them forever (including listing via GoogleDriveBackend).
  app.post("/import-vault", async (req, res) => {
    const { sessionToken, vaultName, items } = req.body || {};
    const session = sessions.get(sessionToken);

    if (!session) {
      res.status(400).json({ error: "Invalid session" });
      return;
    }

    const itemList: Array<{
      id: string;
      name: string;
      mimeType: string;
      resourceKey?: string;
    }> = Array.isArray(items) ? items : [];

    if (itemList.length === 0) {
      res.status(400).json({ error: "No items selected" });
      return;
    }

    try {
      await refreshSessionToken(session);
    } catch (err: any) {
      res
        .status(401)
        .json({ error: "Session expired — please re-authenticate" });
      return;
    }

    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({
      access_token: session.accessToken,
      refresh_token: session.refreshToken,
    });
    const drive = google.drive({ version: "v3", auth: oauth2Client });

    try {
      const name = vaultName || "My Brain";

      // 1. Create the vault folder (app-owned)
      const vaultFolder = await drive.files.create({
        requestBody: {
          name,
          mimeType: "application/vnd.google-apps.folder",
        },
        fields: "id",
        supportsAllDrives: true,
      });
      const vaultId = vaultFolder.data.id!;

      // 2. Create sources subfolder (app-owned)
      const sourcesFolder = await drive.files.create({
        requestBody: {
          name: "sources",
          parents: [vaultId],
          mimeType: "application/vnd.google-apps.folder",
        },
        fields: "id",
        supportsAllDrives: true,
      });

      // 3. Copy each picked file into sources/. drive.files.copy works under
      // drive.file when source is Picker-granted and destination is app-owned.
      // Soft-fail per item so one broken copy doesn't abort the whole import.
      let totalFiles = 0;
      let totalMd = 0;
      let totalDocs = 0;
      const sourceNames: string[] = [];
      const sourceManifest: string[] = [];
      const skippedItems: string[] = [];

      for (const item of itemList) {
        try {
          await drive.files.copy({
            fileId: item.id,
            requestBody: {
              name: item.name,
              parents: [sourcesFolder.data.id!],
            },
            supportsAllDrives: true,
          });
          sourceNames.push(item.name);
          sourceManifest.push(`- [[sources/${item.name}|${item.name}]]`);
          totalFiles++;
          if (item.name?.endsWith(".md")) totalMd++;
          if (item.mimeType === "application/vnd.google-apps.document")
            totalDocs++;
        } catch (copyErr: any) {
          console.error(
            `[Import] Copy failed for ${item.name} (${item.id}): code=${copyErr.code || "?"} status=${copyErr.response?.status || "?"} message=${copyErr.message}`,
          );
          skippedItems.push(item.name);
        }
      }

      // 4. Create welcome note
      const skippedNote =
        skippedItems.length > 0
          ? `\n\n> ⚠️ ${skippedItems.length} file${skippedItems.length > 1 ? "s" : ""} couldn't be copied and ${skippedItems.length > 1 ? "were" : "was"} skipped: ${skippedItems.join(", ")}. ${skippedItems.length > 1 ? "They" : "It"} may have restricted sharing permissions.`
          : "";

      await drive.files.create({
        requestBody: {
          name: "Welcome to Synapse.md",
          parents: [vaultId],
          mimeType: "text/markdown",
        },
        media: {
          mimeType: "text/markdown",
          body: `# Welcome to ${name}\n\nImported ${totalFiles} file${totalFiles !== 1 ? "s" : ""} from your Google Drive. The copies live in the \`sources/\` folder — your originals in Drive are untouched.${skippedNote}\n\n## Sources\n${sourceManifest.join("\n")}\n\n## Get started\n\nTell Claude:\n\n> "Organize my brain"\n\nThis will read your sources, convert everything to markdown, and build a wiki with summaries, concept pages, and cross-linked notes. The more you compile, the smarter your brain gets.\n`,
        },
        supportsAllDrives: true,
      });

      session.folderId = vaultId;
      session.folderName = name;

      res.json({
        redirect: `/vault-purpose?session=${sessionToken}&source=import&files=${totalFiles}&folders=0&md=${totalMd}&docs=${totalDocs}&sourceNames=${encodeURIComponent(sourceNames.join(","))}`,
        imported: totalFiles,
        skipped: skippedItems.length,
      });
    } catch (err: any) {
      console.error(`[Import] Fatal error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // Step 4: Store folder selection, move to purpose step
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

    // Store folder info on session (don't set up MCP yet)
    session.folderId = folderId;
    session.folderName = folderName;

    const source = (req.query.source as string) || "";
    const sourceParam = source ? `&source=${source}` : "";
    res.redirect(`/vault-purpose?session=${sessionToken}${sourceParam}`);
  });

  // Step 5: What's this brain for?
  app.get("/vault-purpose", async (req, res) => {
    const sessionToken = req.query.session as string;
    const session = sessions.get(sessionToken);

    if (!session || !session.folderId) {
      res.status(400).send("Invalid session");
      return;
    }

    // Forward import stats if they exist — parseInt to prevent injection via query params
    const source = (req.query.source as string) || "";
    const files = parseInt((req.query.files as string) || "0") || 0;
    const folders = parseInt((req.query.folders as string) || "0") || 0;
    const md = parseInt((req.query.md as string) || "0") || 0;
    const docs = parseInt((req.query.docs as string) || "0") || 0;
    const sourceNames = encodeURIComponent(
      (req.query.sourceNames as string) || "",
    );

    const extra =
      source === "import"
        ? `&source=import&files=${files}&folders=${folders}&md=${md}&docs=${docs}&sourceNames=${sourceNames}`
        : "";

    // New vaults skip preview (nothing to show) — go straight to client picker
    const nextStep = source === "create" ? "connect" : "vault-preview";

    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Synapse — What's this for?</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${pageStyles}</style>
</head>
<body>
  <div class="container">
    ${pageHeader}
    <a href="/pick-folder?session=${sessionToken}" class="back-link">&larr; Back</a>
    <h1>What will you use this for?</h1>
    <p class="subtitle">This helps us tailor your experience. You can always change this later.</p>

    <a href="/${nextStep}?session=${sessionToken}&purpose=research${extra}" class="option-card">
      <h3>Research</h3>
      <p>Collecting articles, papers, and notes on a topic. Building expertise over time.</p>
    </a>

    <a href="/${nextStep}?session=${sessionToken}&purpose=business${extra}" class="option-card">
      <h3>Business</h3>
      <p>Company knowledge, processes, client notes, competitive intel. Your team's brain.</p>
    </a>

    <a href="/${nextStep}?session=${sessionToken}&purpose=personal${extra}" class="option-card">
      <h3>Personal</h3>
      <p>Life organization — ideas, journals, bookmarks, things you want to remember.</p>
    </a>

    <a href="/${nextStep}?session=${sessionToken}&purpose=academic${extra}" class="option-card">
      <h3>Academic</h3>
      <p>Coursework, lecture notes, research papers, thesis materials.</p>
    </a>
  </div>
</body>
</html>`);
  });

  // Step 6: Vault scan preview
  app.get("/vault-preview", async (req, res) => {
    const sessionToken = req.query.session as string;
    const purpose = sanitizePurpose((req.query.purpose as string) || "");
    const source = req.query.source as string; // "import" if files were imported
    const session = sessions.get(sessionToken);

    if (!session || !session.folderId) {
      res.status(400).send("Invalid session");
      return;
    }

    let fileCount = 0;
    let folderCount = 0;
    let mdCount = 0;
    let docCount = 0;
    let sourceNames: string[] = [];
    let isImport = source === "import";

    if (isImport) {
      // Stats were passed from the import step
      fileCount = parseInt(req.query.files as string) || 0;
      folderCount = parseInt(req.query.folders as string) || 0;
      mdCount = parseInt(req.query.md as string) || 0;
      docCount = parseInt(req.query.docs as string) || 0;
      sourceNames = ((req.query.sourceNames as string) || "")
        .split(",")
        .filter(Boolean);
    } else {
      // Scan the selected folder directly
      try {
        await refreshSessionToken(session);
      } catch (err: any) {
        console.error(`[VaultPreview] Token refresh failed: ${err.message}`);
      }

      const oauth2Client = getOAuth2Client();
      oauth2Client.setCredentials({
        access_token: session.accessToken,
        refresh_token: session.refreshToken,
      });
      const drive = google.drive({ version: "v3", auth: oauth2Client });

      try {
        const result = await drive.files.list({
          q: `'${session.folderId}' in parents and trashed = false`,
          fields: "files(id, name, mimeType)",
          pageSize: 500,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });

        const files = result.data.files || [];
        for (const f of files) {
          if (f.mimeType === "application/vnd.google-apps.folder") {
            folderCount++;
          } else {
            fileCount++;
            if (f.name?.endsWith(".md")) mdCount++;
            if (f.mimeType === "application/vnd.google-apps.document")
              docCount++;
          }
        }
      } catch (err: any) {
        console.error(
          `[VaultPreview] Drive list failed for folderId=${session.folderId}: ${err.message}`,
        );
      }
    }

    const hasContent = fileCount > 0 || folderCount > 0;

    const statCard = (num: number, label: string) =>
      `<div style="background:white;border:1px solid rgba(61,53,41,0.08);border-radius:8px;padding:16px;text-align:center;">
        <div style="font-size:28px;font-weight:700;color:#1A5C32;">${num}</div>
        <div style="font-size:13px;color:#8B9490;">${label}</div>
      </div>`;

    const statsHtml = hasContent
      ? `<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:24px;">
          ${statCard(fileCount, "files")}
          ${statCard(folderCount, "folders")}
          ${mdCount > 0 ? statCard(mdCount, "markdown files") : ""}
          ${docCount > 0 ? statCard(docCount, "Google Docs") : ""}
        </div>`
      : `<div style="background:white;border:1px solid rgba(61,53,41,0.08);border-radius:8px;padding:20px;margin-bottom:24px;text-align:center;">
          <p style="font-size:15px;color:#8B9490;">Empty folder — your brain starts fresh. That's perfect.</p>
        </div>`;

    const sourceList =
      isImport && sourceNames.length > 0
        ? `<div style="margin-bottom:20px;">
          <p style="font-size:13px;color:#8B9490;margin-bottom:8px;">Pulling from:</p>
          ${sourceNames.map((n) => `<span style="display:inline-block;font-size:13px;padding:4px 10px;background:rgba(26,92,50,0.06);border-radius:20px;color:#1A5C32;margin:0 4px 4px 0;">${escapeHtml(n)}</span>`).join("")}
        </div>`
        : "";

    const title = escapeHtml(session.folderName);
    const subtitle = isImport
      ? `We found ${fileCount} files across ${sourceNames.length} folder${sourceNames.length > 1 ? "s" : ""}. Claude will compile these into your brain.`
      : hasContent
        ? "Here's what we found in your folder."
        : "A blank canvas for your knowledge.";

    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Synapse — Your Vault</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${pageStyles}</style>
</head>
<body>
  <div class="container">
    ${pageHeader}
    <a href="javascript:history.back()" class="back-link">&larr; Back</a>
    <h1>${title}</h1>
    <p class="subtitle">${subtitle}</p>

    ${sourceList}
    ${statsHtml}

    <a href="/connect?session=${sessionToken}&purpose=${purpose}" class="btn" style="display:block;text-align:center;">
      ${hasContent ? "Connect this vault" : "Get started"}
    </a>
  </div>
</body>
</html>`);
  });

  // Step 7: Which AI client?
  app.get("/connect", async (req, res) => {
    const sessionToken = req.query.session as string;
    const purpose = sanitizePurpose((req.query.purpose as string) || "");
    const session = sessions.get(sessionToken);

    if (!session || !session.folderId) {
      res.status(400).send("Invalid session");
      return;
    }

    // ── Scaffold the vault with CLAUDE.md, index.md, sources/, config ──
    // This runs once when the user reaches the /connect step.
    // Both Path A (create) and Path B (import) converge here.
    try {
      await refreshSessionToken(session);
      const oauth2 = getOAuth2Client();
      oauth2.setCredentials({
        access_token: session.accessToken,
        refresh_token: session.refreshToken,
      });
      const drive = google.drive({ version: "v3", auth: oauth2 });
      const vaultId = session.folderId;
      const configPurpose = mapPurposeToConfig(purpose);
      const today = new Date().toISOString().split("T")[0];

      // Check what already exists (import path creates sources/ already)
      const existing = await drive.files.list({
        q: `'${vaultId}' in parents and trashed = false`,
        fields: "files(name, mimeType)",
        supportsAllDrives: true,
      });
      const existingNames = new Set(
        (existing.data.files || []).map((f) => f.name),
      );

      // Create sources/ if not present (Path A doesn't create it)
      if (!existingNames.has("sources")) {
        await drive.files.create({
          requestBody: {
            name: "sources",
            parents: [vaultId],
            mimeType: "application/vnd.google-apps.folder",
          },
          fields: "id",
          supportsAllDrives: true,
        });
      }

      // Create notes/ folder
      if (!existingNames.has("notes")) {
        await drive.files.create({
          requestBody: {
            name: "notes",
            parents: [vaultId],
            mimeType: "application/vnd.google-apps.folder",
          },
          fields: "id",
          supportsAllDrives: true,
        });
      }

      // Create outputs/ folder
      if (!existingNames.has("outputs")) {
        await drive.files.create({
          requestBody: {
            name: "outputs",
            parents: [vaultId],
            mimeType: "application/vnd.google-apps.folder",
          },
          fields: "id",
          supportsAllDrives: true,
        });
      }

      // Write CLAUDE.md (personalized from purpose)
      if (!existingNames.has("CLAUDE.md")) {
        const claudeContent = generateClaudeMd({
          topic: session.folderName || "general knowledge",
          purpose: configPurpose,
          sourcesFolder: "sources",
          notesFolder: "notes",
          outputsFolder: "outputs",
          fileNaming: "kebab-case",
          useWikilinks: true,
          useFrontmatter: true,
        });
        await drive.files.create({
          requestBody: {
            name: "CLAUDE.md",
            parents: [vaultId],
            mimeType: "text/markdown",
          },
          media: { mimeType: "text/markdown", body: claudeContent },
          supportsAllDrives: true,
        });
      }

      // Write index.md
      if (!existingNames.has("index.md")) {
        const indexContent = INDEX_TEMPLATE.replace(/\{DATE\}/g, today).replace(
          /\{TOPIC\}/g,
          session.folderName || "My Brain",
        );
        await drive.files.create({
          requestBody: {
            name: "index.md",
            parents: [vaultId],
            mimeType: "text/markdown",
          },
          media: { mimeType: "text/markdown", body: indexContent },
          supportsAllDrives: true,
        });
      }

      // Write .synapse/config.json
      if (!existingNames.has(".synapse")) {
        const synapseDir = await drive.files.create({
          requestBody: {
            name: ".synapse",
            parents: [vaultId],
            mimeType: "application/vnd.google-apps.folder",
          },
          fields: "id",
          supportsAllDrives: true,
        });
        const config = {
          mode: "structured",
          sourcesFolder: "sources",
          wikiFolder: "notes",
          outputsFolder: "outputs",
          fileNaming: "kebab-case",
          useFrontmatter: true,
          useWikilinks: true,
          schemaPath: "CLAUDE.md",
          topic: session.folderName || null,
          purpose: configPurpose,
          purposeDescription: null,
          configuredAt: new Date().toISOString(),
        };
        await drive.files.create({
          requestBody: {
            name: "config.json",
            parents: [synapseDir.data.id!],
            mimeType: "application/json",
          },
          media: {
            mimeType: "application/json",
            body: JSON.stringify(config, null, 2),
          },
          supportsAllDrives: true,
        });
      }
    } catch (err: any) {
      // Non-fatal — vault still works, just without CLAUDE.md scaffolding.
      // The user can still run synapse_setup from their AI client.
      console.error(`[Connect] Scaffold error: ${err.message}`);
    }

    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Synapse — Connect Your AI</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${pageStyles}</style>
</head>
<body>
  <div class="container">
    ${pageHeader}
    <a href="javascript:history.back()" class="back-link">&larr; Back</a>
    <h1>Almost there</h1>
    <p class="subtitle">Which AI do you use? We'll show you exactly how to connect.</p>

    <a href="/setup-complete?session=${sessionToken}&client=claude&purpose=${purpose}" class="option-card">
      <h3>Claude.ai</h3>
      <p>Anthropic's web app — works on desktop and mobile.</p>
    </a>

    <a href="/setup-complete?session=${sessionToken}&client=chatgpt&purpose=${purpose}" class="option-card">
      <h3>ChatGPT</h3>
      <p>OpenAI's web app with MCP integration support.</p>
    </a>

    <a href="/setup-complete?session=${sessionToken}&client=cursor&purpose=${purpose}" class="option-card">
      <h3>Cursor / Windsurf</h3>
      <p>AI-powered code editors with MCP support.</p>
    </a>

    <a href="/setup-complete?session=${sessionToken}&client=other&purpose=${purpose}" class="option-card">
      <h3>Other MCP client</h3>
      <p>Any app that supports the Model Context Protocol.</p>
    </a>
  </div>
</body>
</html>`);
  });

  // Step 8: Tailored success page
  app.get("/setup-complete", async (req, res) => {
    const sessionToken = req.query.session as string;
    const client = sanitizeClient((req.query.client as string) || "");
    const purpose = sanitizePurpose((req.query.purpose as string) || "");
    const session = sessions.get(sessionToken);

    if (!session || !session.folderId) {
      res.status(400).send("Invalid session");
      return;
    }

    const mcpUrl = `${BASE_URL}/mcp/${sessionToken}`;

    const clientInstructions: Record<string, string> = {
      claude: `
        <ol class="steps">
          <li>Go to <strong>claude.ai</strong></li>
          <li>Click your <strong>name</strong> (bottom-left) &rarr; <strong>Settings</strong></li>
          <li>Click <strong>Integrations</strong> in the sidebar</li>
          <li>Click <strong>"Add Custom Integration"</strong></li>
          <li>Paste your MCP URL and click <strong>Connect</strong></li>
        </ol>`,
      chatgpt: `
        <ol class="steps">
          <li>Go to <strong>chatgpt.com</strong></li>
          <li>Click your <strong>name</strong> (bottom-left) &rarr; <strong>Settings</strong></li>
          <li>Go to <strong>Connected apps</strong> or <strong>Plugins</strong></li>
          <li>Add a <strong>custom MCP integration</strong></li>
          <li>Paste your MCP URL and click <strong>Save</strong></li>
        </ol>`,
      cursor: `
        <ol class="steps">
          <li>Open <strong>Settings</strong> (Cmd/Ctrl + ,)</li>
          <li>Go to <strong>MCP Servers</strong></li>
          <li>Click <strong>"Add Server"</strong></li>
          <li>Choose <strong>"Streamable HTTP"</strong> as the transport</li>
          <li>Paste your MCP URL and save</li>
        </ol>`,
      other: `
        <ol class="steps">
          <li>Open your MCP client's <strong>settings</strong></li>
          <li>Find the <strong>MCP integrations</strong> or <strong>server</strong> section</li>
          <li>Add a new <strong>Streamable HTTP</strong> server</li>
          <li>Paste your MCP URL</li>
        </ol>`,
    };

    const purposePrompts: Record<string, string> = {
      research: `
        <div class="prompt-card"><p class="prompt-label">Build your research wiki:</p><p class="prompt-text">"Organize my brain"</p></div>
        <div class="prompt-card"><p class="prompt-label">Save a paper or article:</p><p class="prompt-text">"Save this article: [paste URL]"</p></div>
        <div class="prompt-card"><p class="prompt-label">Query across everything:</p><p class="prompt-text">"What does my research say about [topic]?"</p></div>`,
      business: `
        <div class="prompt-card"><p class="prompt-label">Organize your company knowledge:</p><p class="prompt-text">"Organize my brain"</p></div>
        <div class="prompt-card"><p class="prompt-label">Save competitive intel:</p><p class="prompt-text">"Save this article: [paste URL]"</p></div>
        <div class="prompt-card"><p class="prompt-label">Get instant answers:</p><p class="prompt-text">"What do we know about [client/competitor/process]?"</p></div>`,
      personal: `
        <div class="prompt-card"><p class="prompt-label">Build your personal wiki:</p><p class="prompt-text">"Organize my brain"</p></div>
        <div class="prompt-card"><p class="prompt-label">Save something interesting:</p><p class="prompt-text">"Save this article: [paste URL]"</p></div>
        <div class="prompt-card"><p class="prompt-label">Search your brain:</p><p class="prompt-text">"What do my notes say about [topic]?"</p></div>`,
      academic: `
        <div class="prompt-card"><p class="prompt-label">Organize your course materials:</p><p class="prompt-text">"Organize my brain"</p></div>
        <div class="prompt-card"><p class="prompt-label">Save lecture notes or papers:</p><p class="prompt-text">"Save this article: [paste URL]"</p></div>
        <div class="prompt-card"><p class="prompt-label">Study across your notes:</p><p class="prompt-text">"Summarize what I know about [topic]"</p></div>`,
    };

    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Synapse — You're Connected!</title>
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
      position: relative;
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
      width: 24px; height: 24px;
      background: rgba(26,92,50,0.1);
      color: #1A5C32;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 12px; font-weight: 600; flex-shrink: 0;
    }
    .prompt-card {
      background: white;
      border: 1px solid rgba(61,53,41,0.08);
      border-radius: 8px;
      padding: 16px 20px;
      margin-bottom: 8px;
    }
    .prompt-label { font-size: 13px; color: #8B9490; margin-bottom: 4px; }
    .prompt-text { font-size: 15px; font-style: italic; color: #3D3529; }
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
    <h1>You're connected</h1>
    <p class="subtitle">"${escapeHtml(session.folderName)}" is live. Here's how to start using it.</p>

    <h3 style="font-size:14px;font-family:monospace;text-transform:uppercase;letter-spacing:0.1em;color:#8B9490;margin-bottom:8px;">Step 1 — Copy your URL</h3>
    <div class="url-box" onclick="copyUrl()">
      ${mcpUrl}
      <span id="copied" style="display:none; color: #2ECC71; margin-left: 8px;">Copied!</span>
    </div>

    <h3 style="font-size:14px;font-family:monospace;text-transform:uppercase;letter-spacing:0.1em;color:#8B9490;margin-top:28px;margin-bottom:8px;">Step 2 — Add to ${client === "claude" ? "Claude" : client === "chatgpt" ? "ChatGPT" : client === "cursor" ? "Cursor" : "your client"}</h3>
    ${clientInstructions[client] || clientInstructions.other}

    <h3 style="font-size:14px;font-family:monospace;text-transform:uppercase;letter-spacing:0.1em;color:#8B9490;margin-top:28px;margin-bottom:8px;">Step 3 — Try these</h3>
    ${purposePrompts[purpose] || purposePrompts.personal}

    <p class="note">
      "Organize my brain" is the magic one — it turns your raw files into a wiki with summaries, concept pages, and cross-linked notes. Every compile makes the brain smarter.
    </p>
  </div>
</body>
</html>`);
  });

  // --- MCP Endpoint (per-transport) ---
  // McpServer only supports one transport, so we create a fresh server+transport pair per MCP session.

  const mcpSessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: McpServer }
  >();

  function createMcpServer(
    accessToken: string,
    refreshToken: string | undefined,
    folderId: string,
  ): McpServer {
    const backend = new GoogleDriveBackend({
      accessToken,
      refreshToken,
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      rootFolderId: folderId,
    });
    const server = new McpServer({
      name: "synapse",
      version: pkg.version,
    });
    registerVaultTools(server, backend);
    registerKnowledgeTools(server, backend);
    registerInitTools(server, backend);
    registerPrompts(server, backend);
    return server;
  }

  app.post("/mcp/:sessionToken", async (req, res) => {
    const { sessionToken } = req.params;
    const session = sessions.get(sessionToken);

    if (!session || !session.folderId) {
      res.status(401).json({
        error: "Invalid session. Visit /auth/google to connect your vault.",
      });
      return;
    }

    const mcpSessionId = (req.headers["mcp-session-id"] as string) || undefined;
    const transportKey = mcpSessionId
      ? `${sessionToken}:${mcpSessionId}`
      : undefined;

    const entry = transportKey ? mcpSessions.get(transportKey) : undefined;

    if (entry) {
      await entry.transport.handleRequest(req, res, req.body);
      return;
    }

    // New MCP session — create fresh server + transport
    const server = createMcpServer(
      session.accessToken,
      session.refreshToken,
      session.folderId,
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    await server.connect(transport);
    // handleRequest generates the session ID on first call
    await transport.handleRequest(req, res, req.body);

    // NOW sessionId is set — store for subsequent requests
    const sid = (transport as any).sessionId as string;
    if (sid) {
      const newKey = `${sessionToken}:${sid}`;
      mcpSessions.set(newKey, { transport, server });

      transport.onclose = () => {
        mcpSessions.delete(newKey);
      };
    }
  });

  app.get("/mcp/:sessionToken", async (req, res) => {
    const { sessionToken } = req.params;
    const mcpSessionId = req.headers["mcp-session-id"] as string;
    const transportKey = `${sessionToken}:${mcpSessionId}`;
    const entry = mcpSessions.get(transportKey);

    if (!entry) {
      res.status(400).json({ error: "Invalid session" });
      return;
    }

    await entry.transport.handleRequest(req, res);
  });

  app.delete("/mcp/:sessionToken", async (req, res) => {
    const { sessionToken } = req.params;
    const mcpSessionId = req.headers["mcp-session-id"] as string;
    const transportKey = `${sessionToken}:${mcpSessionId}`;

    const entry = mcpSessions.get(transportKey);
    if (entry) {
      await entry.transport.close();
      mcpSessions.delete(transportKey);
    }

    res.status(200).json({ ok: true });
  });

  // --- Health & Landing ---

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: "synapse-cloud",
      version: pkg.version,
      activeSessions: sessions.size,
    });
  });

  // Serve static pages from landing/
  const landingHtml = readFileSync(
    resolve(__dirname, "../landing/index.html"),
    "utf-8",
  );
  const privacyHtml = readFileSync(
    resolve(__dirname, "../landing/privacy.html"),
    "utf-8",
  );
  const termsHtml = readFileSync(
    resolve(__dirname, "../landing/terms.html"),
    "utf-8",
  );

  app.get("/", (_req, res) => {
    res.type("html").send(landingHtml);
  });

  app.get("/privacy", (_req, res) => {
    res.type("html").send(privacyHtml);
  });

  app.get("/terms", (_req, res) => {
    res.type("html").send(termsHtml);
  });

  app.listen(port, () => {
    console.error(`Synapse Cloud running at ${BASE_URL}`);
    console.error(`Connect: ${BASE_URL}/auth/google`);
    console.error(`Health: ${BASE_URL}/health`);
  });
}
