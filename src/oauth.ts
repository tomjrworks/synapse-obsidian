import { randomUUID, randomBytes, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";

// Persist tokens to file so they survive restarts
const TOKEN_FILE = path.join(
  process.env.HOME || "/tmp",
  ".synapse-tokens.json",
);

function loadTokens(): Set<string> {
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
    return new Set(data.tokens || []);
  } catch {
    return new Set();
  }
}

function saveTokens(tokens: Set<string>): void {
  try {
    fs.writeFileSync(
      TOKEN_FILE,
      JSON.stringify({ tokens: [...tokens] }),
      "utf-8",
    );
  } catch (err) {
    console.error(`[OAuth] Failed to persist tokens: ${err}`);
  }
}

const clients = new Map<string, { name: string; redirectUris: string[] }>();
const authCodes = new Map<
  string,
  {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    expiresAt: number;
  }
>();
const accessTokens = loadTokens();

const OWNER_PASSWORD = process.env.SYNAPSE_PASSWORD || "synapse";

/**
 * Register all OAuth 2.1 endpoints on the Express app.
 * Claude.ai constructs /authorize and /token from the MCP server base URL.
 */
export function registerOAuthRoutes(app: Express, baseUrl: string): void {
  // --- Discovery: Protected Resource Metadata ---
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
    });
  });

  // --- Discovery: Authorization Server Metadata ---
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  // --- Dynamic Client Registration ---
  app.post("/register", (req, res) => {
    const { client_name, redirect_uris } = req.body || {};
    const clientId = randomUUID();

    clients.set(clientId, {
      name: client_name || "Unknown",
      redirectUris: redirect_uris || [],
    });

    console.error(`[OAuth] Registered client: ${clientId} (${client_name})`);

    res.status(201).json({
      client_id: clientId,
      client_name: client_name || "Unknown",
      redirect_uris: redirect_uris || [],
      token_endpoint_auth_method: "none",
    });
  });

  // --- Authorization Endpoint (GET: show form, POST: approve) ---
  app.get("/authorize", (req, res) => {
    const {
      client_id,
      redirect_uri,
      response_type,
      code_challenge,
      code_challenge_method,
      state,
    } = req.query as Record<string, string>;

    if (response_type !== "code") {
      res.status(400).send("Unsupported response_type");
      return;
    }

    const client = clients.get(client_id);
    if (!client) {
      res.status(400).send("Unknown client_id");
      return;
    }

    // Show approval page — Taproot branded
    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Synapse \u2014 Authorize</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #F2F0EB;
      color: #3D3529;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: white;
      border-radius: 12px;
      padding: 40px;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 2px 12px rgba(61,53,41,0.08);
      border: 1px solid rgba(61,53,41,0.06);
    }
    .logo {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .logo-dot { width: 8px; height: 8px; background: #2ECC71; border-radius: 50%; }
    .by { font-size: 12px; color: #8B9490; margin-bottom: 28px; font-family: monospace; text-transform: uppercase; letter-spacing: 0.15em; }
    .request {
      background: rgba(26,92,50,0.05);
      border: 1px solid rgba(26,92,50,0.1);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 24px;
    }
    .request p { font-size: 14px; line-height: 1.6; color: #3D3529; }
    .app-name { font-weight: 600; color: #1A5C32; }
    .permissions { margin-bottom: 24px; }
    .permissions p { font-size: 12px; color: #8B9490; margin-bottom: 8px; font-family: monospace; text-transform: uppercase; letter-spacing: 0.1em; }
    .permissions ul { list-style: none; }
    .permissions li {
      font-size: 14px;
      padding: 6px 0;
      color: rgba(61,53,41,0.7);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .permissions li::before { content: ''; width: 6px; height: 6px; background: #2ECC71; border-radius: 50%; flex-shrink: 0; }
    input[type=password] {
      width: 100%;
      padding: 14px 16px;
      border: 1px solid rgba(61,53,41,0.15);
      border-radius: 6px;
      font-size: 15px;
      margin-bottom: 12px;
      background: #F2F0EB;
      color: #3D3529;
      outline: none;
      transition: border-color 0.2s;
    }
    input[type=password]:focus { border-color: #1A5C32; }
    input[type=password]::placeholder { color: #8B9490; }
    button {
      width: 100%;
      padding: 14px;
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
    }
    button:hover { background: #16472a; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(26,92,50,0.2); }
    .security {
      margin-top: 20px;
      padding-top: 16px;
      border-top: 1px solid rgba(61,53,41,0.06);
      font-size: 12px;
      color: #8B9490;
      line-height: 1.6;
      text-align: center;
    }
    .security a { color: #1A5C32; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo"><span class="logo-dot"></span> Synapse</div>
    <div class="by">by Main Loop Systems</div>
    <div class="request">
      <p><span class="app-name">${client.name}</span> is requesting access to your vault.</p>
    </div>
    <div class="permissions">
      <p>This will allow</p>
      <ul>
        <li>Read files in your vault</li>
        <li>Write and create new files</li>
        <li>Search across your notes</li>
      </ul>
    </div>
    <form method="POST" action="/authorize">
      <input type="hidden" name="client_id" value="${client_id}">
      <input type="hidden" name="redirect_uri" value="${redirect_uri}">
      <input type="hidden" name="code_challenge" value="${code_challenge}">
      <input type="hidden" name="code_challenge_method" value="${code_challenge_method || "S256"}">
      <input type="hidden" name="state" value="${state || ""}">
      <input type="password" name="password" placeholder="Enter your Synapse password" autofocus>
      <button type="submit">Approve Access</button>
    </form>
    <div class="security">
      Your data never leaves your machine. Synapse runs locally and<br>
      only connects your vault to your AI client.<br>
      <a href="https://github.com/tomjrworks/synapse-obsidian">Open source</a> &middot; <a href="https://taproothq.com">Taproot</a>
    </div>
  </div>
</body>
</html>`);
  });

  // Handle form POST with URL-encoded body
  app.post("/authorize", (req: Request, res: Response) => {
    const {
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      state,
      password,
    } = req.body || {};

    if (password !== OWNER_PASSWORD) {
      res.status(403).send(`<!DOCTYPE html>
<html><head><title>Synapse \u2014 Wrong Password</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; background: #F2F0EB; color: #3D3529; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .card { background: white; border-radius: 12px; padding: 40px; max-width: 400px; width: 100%; box-shadow: 0 2px 12px rgba(61,53,41,0.08); border: 1px solid rgba(61,53,41,0.06); text-align: center; }
  h1 { font-size: 20px; margin-bottom: 8px; }
  p { color: #8B9490; font-size: 14px; line-height: 1.6; margin-bottom: 20px; }
  a { display: inline-block; padding: 12px 24px; background: #1A5C32; color: #F2F0EB; border-radius: 6px; text-decoration: none; font-size: 13px; font-family: monospace; text-transform: uppercase; letter-spacing: 0.15em; }
  a:hover { background: #16472a; }
</style>
</head><body><div class="card"><h1>Wrong password</h1><p>The password you entered doesn't match. Check your terminal for the correct password.</p><a href="javascript:history.back()">Try Again</a></div></body></html>`);
      return;
    }

    // Issue authorization code
    const code = randomBytes(32).toString("hex");
    authCodes.set(code, {
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method || "S256",
      expiresAt: Date.now() + 300000, // 5 minutes
    });

    console.error(`[OAuth] Issued auth code for client ${client_id}`);

    // Redirect back to Claude with the code
    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set("code", code);
    if (state) redirectUrl.searchParams.set("state", state);

    res.redirect(redirectUrl.toString());
  });

  // --- Token Endpoint ---
  app.post("/token", (req, res) => {
    const { grant_type, code, redirect_uri, client_id, code_verifier } =
      req.body || {};

    if (grant_type !== "authorization_code") {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }

    const authCode = authCodes.get(code);
    if (!authCode) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }

    // One-time use
    authCodes.delete(code);

    // Check expiry
    if (Date.now() > authCode.expiresAt) {
      res
        .status(400)
        .json({ error: "invalid_grant", error_description: "Code expired" });
      return;
    }

    // Validate client
    if (authCode.clientId !== client_id) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }

    // Validate redirect URI
    if (authCode.redirectUri !== redirect_uri) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }

    // Validate PKCE
    if (code_verifier) {
      const expectedChallenge = createHash("sha256")
        .update(code_verifier)
        .digest("base64url");
      if (expectedChallenge !== authCode.codeChallenge) {
        res.status(400).json({
          error: "invalid_grant",
          error_description: "PKCE verification failed",
        });
        return;
      }
    }

    // Issue access token and persist to disk
    const token = randomBytes(32).toString("hex");
    accessTokens.add(token);
    saveTokens(accessTokens);

    console.error(`[OAuth] Issued access token for client ${client_id}`);

    res.json({
      access_token: token,
      token_type: "Bearer",
      expires_in: 86400 * 30, // 30 days
    });
  });

  // Clean up expired auth codes periodically
  setInterval(() => {
    for (const [code, data] of authCodes) {
      if (Date.now() > data.expiresAt) authCodes.delete(code);
    }
  }, 60000);
}

/**
 * Middleware that validates bearer tokens on protected endpoints.
 * Returns true if auth is required and the request should be blocked.
 */
export function requireAuth(req: Request, res: Response): boolean {
  // If no password is set, auth is disabled
  if (!process.env.SYNAPSE_PASSWORD) return false;

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).set("WWW-Authenticate", "Bearer").json({
      error: "unauthorized",
      error_description: "Bearer token required",
    });
    return true;
  }

  const token = authHeader.slice(7);
  if (!accessTokens.has(token)) {
    res.status(401).set("WWW-Authenticate", "Bearer").json({
      error: "invalid_token",
    });
    return true;
  }

  return false;
}
