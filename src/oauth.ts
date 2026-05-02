import {
  randomUUID,
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import type { Express, Request, Response } from "express";
import { LRUCache } from "lru-cache";
import { supabaseService } from "./api/supabase.js";
import { getMembershipForUser } from "./api/workspace.js";

// T6.3: tokens + clients live in Supabase (`oauth_tokens` + `oauth_clients`
// tables from migration 0004). The raw token is sha256-hashed at rest —
// a SQL leak doesn't grant cloud access. /authorize POST upserts the
// client row keyed on (workspace_id, client_id); /token exchange inserts
// the token row; requireAuth reads through by token_hash.

// /register clients are still tracked in-process until /authorize gives
// them a workspace context. Once authorized, they're persisted to
// oauth_clients (one row per workspace×client).
const pendingClients = new LRUCache<
  string,
  { name: string; redirectUris: string[] }
>({ max: 10_000, ttl: 60 * 60 * 1000 });

const authCodes = new LRUCache<
  string,
  {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    expiresAt: number;
    userId: string;
    workspaceId: string;
    clientName: string;
    redirectUris: string[];
  }
>({ max: 100_000, ttl: 5 * 60 * 1000 });

const TOKEN_TTL_SECONDS = 30 * 86400; // 30 days

function tokenHashHex(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenHashByteaParam(token: string): string {
  // Postgres bytea literal: \x followed by hex. Always pass via this
  // form; supabase-js JSON-stringifies a raw Buffer into
  // {"type":"Buffer","data":[...]} which Postgres stores as the literal
  // bytes of that JSON string (the same trap T4 documented).
  return `\\x${tokenHashHex(token)}`;
}

// XSS defense for HTML interpolation. Encode `&` first or chains break
// (e.g. `<` would become `&amp;lt;`). /security-audit C1 (2026-04-30).
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function authFailedHtml(title: string, message: string): string {
  return `<!DOCTYPE html>
<html><head><title>Taproot — ${escapeHtml(title)}</title>
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
</head><body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a href="javascript:history.back()">Try Again</a></div></body></html>`;
}

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
  // Echoes back the requesting client's metadata, plus our own server identity
  // (client_name="Taproot", logo_uri, client_uri, tos_uri, policy_uri) per
  // RFC 7591 client metadata. Experimental — claude.ai may or may not respect
  // logo_uri for custom connectors. See [[2026-04-26-taproot-tool-fixes-execution-plan]] Task 11.
  app.post("/register", (req, res) => {
    const { client_name, redirect_uris } = req.body || {};

    // /security-audit C1 defense-in-depth (2026-04-30): cap client_name
    // length and reject non-printable / control chars before storing in
    // pendingClients. The /authorize HTML escape is the actual fix; this
    // bounds the attack surface so a giant or weird payload can't be
    // staged for later exploit even if the escape regresses.
    if (
      typeof client_name !== "string" ||
      client_name.length === 0 ||
      client_name.length > 200 ||
      /[\x00-\x1f\x7f]/.test(client_name)
    ) {
      res.status(400).json({
        error: "invalid_client_metadata",
        error_description:
          "client_name must be a non-empty printable string ≤ 200 chars",
      });
      return;
    }

    const clientId = randomUUID();

    pendingClients.set(clientId, {
      name: client_name,
      redirectUris: redirect_uris || [],
    });

    console.error(`[OAuth] Registered client: ${clientId} (${client_name})`);

    res.status(201).json({
      client_id: clientId,
      client_name: "Taproot",
      logo_uri: "https://taproothq.com/images/taproot-logo.png",
      client_uri: "https://taproothq.com",
      tos_uri: "https://taproothq.com",
      policy_uri: "https://taproothq.com",
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

    const client = pendingClients.get(client_id);
    if (!client) {
      res.status(400).send("Unknown client_id");
      return;
    }

    // /security-audit C4 (2026-04-30): redirect_uri must be on the
    // allowlist registered at /register. Exact match — no prefix or
    // wildcard. Closes authorization-code interception via attacker-
    // controlled redirect_uri on a legit client_id.
    if (
      typeof redirect_uri !== "string" ||
      !client.redirectUris.includes(redirect_uri)
    ) {
      res.status(400).send("redirect_uri not registered for this client");
      return;
    }

    // /security-audit C2 (2026-04-30): PKCE is mandatory for public
    // clients. Reject missing code_challenge or any non-S256 method.
    // Discovery already advertises ["S256"] only.
    if (typeof code_challenge !== "string" || !code_challenge) {
      res.status(400).send("Missing code_challenge (PKCE required)");
      return;
    }
    if (code_challenge_method !== "S256") {
      res.status(400).send("Unsupported code_challenge_method (S256 required)");
      return;
    }

    // Show approval page — Taproot branded
    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Taproot \u2014 Authorize</title>
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
    input[type=email],
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
    input[type=email]:focus,
    input[type=password]:focus { border-color: #1A5C32; }
    input[type=email]::placeholder,
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
    <div class="logo"><span class="logo-dot"></span> Taproot</div>
    <div class="by">by Main Loop Systems</div>
    <div class="request">
      <p><span class="app-name">${escapeHtml(client.name)}</span> is requesting access to your vault.</p>
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
      <input type="hidden" name="client_id" value="${escapeHtml(client_id)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(code_challenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(code_challenge_method)}">
      <input type="hidden" name="state" value="${escapeHtml(state || "")}">
      <input type="email" name="email" placeholder="Email" autofocus required>
      <input type="password" name="password" placeholder="Password" required>
      <button type="submit">Approve Access</button>
    </form>
    <div class="security">
      Encrypted at rest. Open source &mdash; check what we do.<br>
      Leave any time and we delete your mirror with one click.<br>
      <a href="https://github.com/tomjrworks/synapse-obsidian">Open source</a> &middot; <a href="https://taproothq.com">Taproot</a>
    </div>
  </div>
</body>
</html>`);
  });

  // Handle form POST with URL-encoded body
  app.post("/authorize", async (req: Request, res: Response) => {
    const {
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      state,
      email,
      password,
    } = req.body || {};

    if (
      typeof email !== "string" ||
      !email.trim() ||
      typeof password !== "string" ||
      !password
    ) {
      res
        .status(400)
        .send(
          authFailedHtml(
            "Missing credentials",
            "Email and password are required.",
          ),
        );
      return;
    }

    // Authenticate against Supabase Auth (the same pool that backs /api/login).
    let userId: string;
    try {
      const sb = supabaseService();
      const { data, error } = await sb.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error || !data.user) {
        res
          .status(403)
          .send(
            authFailedHtml(
              "Sign-in failed",
              "Email or password didn't match. Check the credentials you used to sign up at taproothq.com.",
            ),
          );
        return;
      }
      userId = data.user.id;
    } catch (err: any) {
      console.error(`[OAuth] signInWithPassword threw: ${err.message ?? err}`);
      res
        .status(500)
        .send(
          authFailedHtml(
            "Authentication unavailable",
            "We couldn't reach Supabase Auth. Try again in a moment.",
          ),
        );
      return;
    }

    // Resolve the workspace for this user. Atomic signup (T2) guarantees
    // every confirmed user has exactly one membership; if not, something
    // went wrong server-side.
    const membership = await getMembershipForUser(supabaseService(), userId);
    if (!membership) {
      console.error(`[OAuth] no workspace for user ${userId}`);
      res
        .status(403)
        .send(
          authFailedHtml(
            "No workspace",
            "Your account doesn't have a workspace yet. Finish signup at taproothq.com first.",
          ),
        );
      return;
    }

    // Persist the client to oauth_clients now that we know the workspace.
    // UPSERT keyed on the unique client_id text — `last_authorized_at`
    // doubles as a "last seen" signal for future dashboard surfacing.
    // /security-audit C1+C4 (2026-04-30): pending.name is guaranteed by
    // /register's validation gate; pending.redirectUris is allowlisted by
    // GET /authorize. Drop the legacy ?? "Unknown" / ?? [redirect_uri]
    // fallbacks — they were masking missing validation.
    const pending = pendingClients.get(client_id);
    const clientName = pending?.name ?? "";
    const redirectUris = pending?.redirectUris ?? [];
    try {
      const sb = supabaseService();
      const { error: upsertErr } = await sb.from("oauth_clients").upsert(
        {
          workspace_id: membership.workspaceId,
          client_id,
          client_name: clientName,
          redirect_uris: redirectUris,
          last_authorized_at: new Date().toISOString(),
        },
        { onConflict: "client_id" },
      );
      if (upsertErr) {
        console.error(
          `[OAuth] oauth_clients upsert failed: ${upsertErr.message}`,
        );
        res
          .status(500)
          .send(
            authFailedHtml(
              "Authorization failed",
              "We couldn't record this connection. Try again in a moment.",
            ),
          );
        return;
      }
    } catch (err: any) {
      console.error(
        `[OAuth] oauth_clients upsert threw: ${err.message ?? err}`,
      );
      res
        .status(500)
        .send(
          authFailedHtml(
            "Authorization failed",
            "We couldn't record this connection. Try again in a moment.",
          ),
        );
      return;
    }

    // Issue authorization code, bound to the resolved {userId, workspaceId}
    const code = randomBytes(32).toString("hex");
    authCodes.set(code, {
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method,
      expiresAt: Date.now() + 300000, // 5 minutes
      userId,
      workspaceId: membership.workspaceId,
      clientName,
      redirectUris,
    });

    console.error(
      `[OAuth] Issued auth code for client ${client_id} user ${userId} workspace ${membership.workspaceId}`,
    );

    // Redirect back to the OAuth client with the code
    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set("code", code);
    if (state) redirectUrl.searchParams.set("state", state);

    res.redirect(redirectUrl.toString());
  });

  // --- Token Endpoint ---
  app.post("/token", async (req, res) => {
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

    // /security-audit C2 (2026-04-30): PKCE is REQUIRED for public
    // clients (token_endpoint_auth_methods_supported: ["none"]). The
    // legacy `if (code_verifier)` guard let an attacker who obtained an
    // auth code via any side-channel mint a 30-day bearer by simply
    // omitting code_verifier. RFC 7636 mandates the verifier check.
    if (typeof code_verifier !== "string" || !code_verifier) {
      res.status(400).json({
        error: "invalid_grant",
        error_description: "code_verifier required",
      });
      return;
    }
    const expectedChallenge = createHash("sha256")
      .update(code_verifier)
      .digest("base64url");
    const expectedBuf = Buffer.from(expectedChallenge);
    const actualBuf = Buffer.from(authCode.codeChallenge);
    // timingSafeEqual throws on length mismatch; bail explicitly first.
    if (
      expectedBuf.length !== actualBuf.length ||
      !timingSafeEqual(expectedBuf, actualBuf)
    ) {
      res.status(400).json({
        error: "invalid_grant",
        error_description: "PKCE verification failed",
      });
      return;
    }

    // Mint access token and persist to oauth_tokens. Token is sha256-hashed
    // at rest — a SQL leak doesn't grant cloud access.
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000);
    try {
      const sb = supabaseService();
      const { error: insertErr } = await sb.from("oauth_tokens").insert({
        workspace_id: authCode.workspaceId,
        client_id,
        token_hash: tokenHashByteaParam(token),
        expires_at: expiresAt.toISOString(),
      });
      if (insertErr) {
        console.error(
          `[OAuth] oauth_tokens insert failed: ${insertErr.message}`,
        );
        res.status(500).json({
          error: "server_error",
          error_description: "token_persist_failed",
        });
        return;
      }
    } catch (err: any) {
      console.error(`[OAuth] oauth_tokens insert threw: ${err.message ?? err}`);
      res.status(500).json({
        error: "server_error",
        error_description: "token_persist_failed",
      });
      return;
    }

    console.error(
      `[OAuth] Issued access token for client ${client_id} workspace ${authCode.workspaceId}`,
    );

    res.json({
      access_token: token,
      token_type: "Bearer",
      expires_in: TOKEN_TTL_SECONDS,
    });
  });

  // --- Token Revocation Endpoint (RFC 7009) ---
  // The endpoint always returns 200 when a token field is present, even
  // for unknown / already-revoked / expired tokens, to avoid disclosing
  // token validity to unauthenticated callers (RFC 7009 §2.2).
  app.post("/revoke", async (req, res) => {
    const { token } = req.body || {};
    if (typeof token !== "string" || !token.trim()) {
      res.status(400).json({
        error: "invalid_request",
        error_description: "token parameter required",
      });
      return;
    }
    try {
      const sb = supabaseService();
      const { error } = await sb
        .from("oauth_tokens")
        .update({ revoked_at: new Date().toISOString() })
        .eq("token_hash", tokenHashByteaParam(token))
        .is("revoked_at", null);
      if (error) {
        // Don't leak DB errors to the caller; log + 200 per RFC.
        console.error(`[OAuth] revoke update failed: ${error.message}`);
      }
    } catch (err: any) {
      console.error(`[OAuth] revoke threw: ${err.message ?? err}`);
    }
    // RFC 7009: success response is 200 with empty body.
    res.status(200).end();
  });

  // Clean up expired auth codes periodically
  setInterval(() => {
    for (const [code, data] of authCodes) {
      if (Date.now() > data.expiresAt) authCodes.delete(code);
    }
  }, 60000);
}

/**
 * Express request augmented with the workspace identity resolved from a
 * valid bearer. After `requireAuth` returns false, downstream handlers
 * may read `req.workspaceId` directly.
 *
 * Stage 1 single-user-per-workspace: `userId` is not plumbed onto the
 * request — MCP tool calls operate on the workspace's vault, and any
 * actor-attribution work uses `workspaces.owner_user_id` server-side.
 * Stage 2 (teams) will revisit this once tokens are minted per user.
 */
export interface AuthedMcpRequest extends Request {
  workspaceId: string;
}

/**
 * Middleware that validates bearer tokens on protected endpoints.
 * Returns true if the request should be blocked (response already sent).
 *
 * T6.3: reads `oauth_tokens` by token_hash. Stage-1 latency: a single
 * indexed SELECT per /mcp call. If this becomes the hot path we'll add
 * a short-lived in-memory cache (~30s TTL) here; defer until measured.
 *
 * T6.4: on success, attaches the validated `workspace_id` onto the
 * request as `(req as AuthedMcpRequest).workspaceId`.
 */
export async function requireAuth(
  req: Request,
  res: Response,
): Promise<boolean> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).set("WWW-Authenticate", "Bearer").json({
      error: "unauthorized",
      error_description: "Bearer token required",
    });
    return true;
  }

  const token = authHeader.slice(7);
  try {
    const sb = supabaseService();
    const { data, error } = await sb
      .from("oauth_tokens")
      .select("workspace_id, expires_at, revoked_at")
      .eq("token_hash", tokenHashByteaParam(token))
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (error || !data) {
      res.status(401).set("WWW-Authenticate", "Bearer").json({
        error: "invalid_token",
      });
      return true;
    }
    (req as AuthedMcpRequest).workspaceId = data.workspace_id as string;
    // Best-effort last_used_at touch; failures don't block the request.
    sb.from("oauth_tokens")
      .update({ last_used_at: new Date().toISOString() })
      .eq("token_hash", tokenHashByteaParam(token))
      .then(({ error: updErr }) => {
        if (updErr) {
          console.error(
            `[OAuth] last_used_at update failed: ${updErr.message}`,
          );
        }
      });
  } catch (err: any) {
    console.error(`[OAuth] requireAuth threw: ${err.message ?? err}`);
    res.status(500).json({
      error: "server_error",
      error_description: "auth_lookup_failed",
    });
    return true;
  }

  return false;
}
