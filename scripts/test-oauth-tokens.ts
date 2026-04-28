/**
 * Stage 1 T6.3 — DB-backed OAuth tokens smoke.
 *
 * Provisions a test user + workspace, spawns the HTTP server, drives the
 * full OAuth handshake, and inspects `oauth_tokens` + `oauth_clients`
 * directly to assert:
 *   - oauth_clients UPSERT happens at /authorize POST
 *   - oauth_tokens INSERT happens at /token POST with sha256 token_hash
 *   - expires_at lands ~30d in the future
 *   - bad token → 401 from /mcp
 *   - expired token (manually backdate expires_at) → 401
 *   - revoked token (manually set revoked_at) → 401
 *   - last_used_at is touched on a successful /mcp call
 *
 * Run: tsx scripts/test-oauth-tokens.ts
 *   Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TAPROOT_KEK in env.
 */
import { createClient } from "@supabase/supabase-js";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDek, wrapDek } from "../src/api/crypto.js";
import { nukeWorkspace } from "../src/utils/supabase-mirror.js";

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}: ${JSON.stringify(detail)}`);
    console.log(`  ✗ ${name}  →  ${JSON.stringify(detail)}`);
  }
}

const PORT = 3879;
const BASE = `http://localhost:${PORT}`;
const TEST_USER_PASSWORD = "t6-3-pw-12345";
const testEmail = `t6-3-${Date.now()}@taproot-test.local`;
let userId: string | null = null;
let workspaceId: string | null = null;
let serverProc: ChildProcess | null = null;
let tmpVault: string | null = null;

async function waitForHealth(url: string, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function tokenHashHex(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function obtainBearer(): Promise<{
  bearer: string;
  clientId: string;
}> {
  const reg = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "t6-3-smoke-client",
      redirect_uris: ["http://localhost/oauth/callback"],
    }),
  });
  const { client_id } = await reg.json();
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  const authForm = new URLSearchParams({
    client_id,
    redirect_uri: "http://localhost/oauth/callback",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state: "t6-3-state",
    email: testEmail,
    password: TEST_USER_PASSWORD,
  });
  const authRes = await fetch(`${BASE}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: authForm.toString(),
    redirect: "manual",
  });
  if (authRes.status !== 302) {
    throw new Error(`/authorize ${authRes.status}: ${await authRes.text()}`);
  }
  const code = new URL(authRes.headers.get("location") ?? "").searchParams.get(
    "code",
  );
  const tokenForm = new URLSearchParams({
    grant_type: "authorization_code",
    code: code ?? "",
    redirect_uri: "http://localhost/oauth/callback",
    client_id,
    code_verifier: codeVerifier,
  });
  const tokenRes = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenForm.toString(),
  });
  const { access_token } = await tokenRes.json();
  return { bearer: access_token, clientId: client_id };
}

async function mcpInitWithBearer(bearer: string): Promise<number> {
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t6-3-smoke", version: "0.0.1" },
      },
    }),
  });
  // Drain body so the connection closes cleanly.
  await r.text();
  return r.status;
}

try {
  console.log(`\n→ Provisioning test user (${testEmail})`);
  const { data: userData, error: userErr } = await sb.auth.admin.createUser({
    email: testEmail,
    password: TEST_USER_PASSWORD,
    email_confirm: true,
  });
  if (userErr || !userData.user) throw userErr ?? new Error("no user data");
  userId = userData.user.id;
  check("admin.createUser succeeds", true);
  const wrappedParam = `\\x${wrapDek(generateDek()).toString("hex")}`;
  const { data: wsData, error: wsErr } = await sb.rpc(
    "create_workspace_for_new_user",
    {
      p_user_id: userId,
      p_workspace_name: "t6-3-smoke",
      p_wrapped_dek: wrappedParam,
    },
  );
  if (wsErr) throw wsErr;
  workspaceId = wsData as string;
  check(
    "atomic signup RPC returns workspace_id",
    typeof workspaceId === "string",
  );

  console.log(`\n→ Spawning server (port ${PORT})`);
  tmpVault = mkdtempSync(join(tmpdir(), "taproot-oauth-tokens-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(PORT),
  };
  delete env.SYNAPSE_PASSWORD;
  serverProc = spawn(
    "npx",
    ["tsx", "src/index.ts", tmpVault, "--http", "--port", String(PORT)],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const serverLogs: string[] = [];
  serverProc.stdout?.on("data", (d) => serverLogs.push(`[stdout] ${d}`));
  serverProc.stderr?.on("data", (d) => serverLogs.push(`[stderr] ${d}`));
  if (!(await waitForHealth(BASE))) {
    console.error(serverLogs.slice(-20).join(""));
    throw new Error("server boot failed");
  }
  check("server up at /health", true);

  console.log("\n→ Mint a bearer via OAuth handshake");
  const { bearer, clientId } = await obtainBearer();
  check("bearer obtained via /authorize + /token", bearer.length > 0);

  console.log("\n→ DB invariants on oauth_clients + oauth_tokens");

  const { data: clientRow } = await sb
    .from("oauth_clients")
    .select(
      "id, workspace_id, client_id, client_name, redirect_uris, last_authorized_at",
    )
    .eq("client_id", clientId)
    .maybeSingle();
  check(
    "oauth_clients row UPSERTed for workspace + client_id",
    clientRow?.workspace_id === workspaceId &&
      clientRow?.client_name === "t6-3-smoke-client",
    clientRow,
  );
  check(
    "oauth_clients.last_authorized_at populated",
    typeof clientRow?.last_authorized_at === "string",
    clientRow?.last_authorized_at,
  );

  const expectedHash = `\\x${tokenHashHex(bearer)}`;
  const { data: tokenRow } = await sb
    .from("oauth_tokens")
    .select(
      "id, workspace_id, client_id, token_hash, expires_at, revoked_at, last_used_at",
    )
    .eq("token_hash", expectedHash)
    .maybeSingle();
  check(
    "oauth_tokens row inserted with correct workspace + client_id",
    tokenRow?.workspace_id === workspaceId && tokenRow?.client_id === clientId,
    tokenRow,
  );
  check(
    "oauth_tokens.expires_at lands ~30d in the future",
    (() => {
      if (!tokenRow?.expires_at) return false;
      const exp = new Date(tokenRow.expires_at).getTime();
      const target = Date.now() + 30 * 86400 * 1000;
      return Math.abs(exp - target) < 60_000; // within a minute
    })(),
    tokenRow?.expires_at,
  );
  check(
    "oauth_tokens.token_hash stored as bytea (sha256 of raw token)",
    // Supabase returns bytea as `\\x...` hex string. Our query already
    // matched via expectedHash; the existence of tokenRow confirms it.
    !!tokenRow,
    tokenRow?.token_hash,
  );

  console.log("\n→ Positive: bearer authenticates /mcp; last_used_at touched");
  const okStatus = await mcpInitWithBearer(bearer);
  check("/mcp initialize with valid bearer → 200", okStatus === 200, okStatus);

  // last_used_at is updated fire-and-forget, so give it a moment.
  await new Promise((r) => setTimeout(r, 250));
  const { data: rowAfterUse } = await sb
    .from("oauth_tokens")
    .select("last_used_at")
    .eq("token_hash", expectedHash)
    .maybeSingle();
  check(
    "/mcp call touches last_used_at on the token row",
    typeof rowAfterUse?.last_used_at === "string",
    rowAfterUse?.last_used_at,
  );

  console.log("\n→ Negative: bad bearer → 401");
  const bogus = await mcpInitWithBearer("not-a-real-token-xxxxxxxx");
  check("/mcp with bogus bearer → 401", bogus === 401, bogus);

  console.log("\n→ Negative: expired token (backdate expires_at) → 401");
  await sb
    .from("oauth_tokens")
    .update({
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    })
    .eq("token_hash", expectedHash);
  const expiredStatus = await mcpInitWithBearer(bearer);
  check("/mcp with expired bearer → 401", expiredStatus === 401, expiredStatus);

  // Restore expiry so the revoke test is independent of the expiry test.
  await sb
    .from("oauth_tokens")
    .update({
      expires_at: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
    })
    .eq("token_hash", expectedHash);

  console.log("\n→ Negative: revoked token (set revoked_at) → 401");
  await sb
    .from("oauth_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token_hash", expectedHash);
  const revokedStatus = await mcpInitWithBearer(bearer);
  check("/mcp with revoked bearer → 401", revokedStatus === 401, revokedStatus);

  console.log(`\n${pass} pass, ${fail} fail`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
} catch (err: any) {
  console.error(`\nFATAL: ${err.message ?? err}`);
  fail++;
} finally {
  console.log("\nCleanup:");
  if (serverProc && !serverProc.killed) {
    serverProc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
  }
  if (workspaceId) {
    try {
      await nukeWorkspace(sb, workspaceId, userId ?? "system");
    } catch {}
    const r = await sb.from("workspaces").delete().eq("id", workspaceId);
    console.log(`  workspaces delete: ${r.error ? r.error.message : "ok"}`);
  }
  if (userId) {
    const r = await sb.auth.admin.deleteUser(userId);
    console.log(`  user delete: ${r.error ? r.error.message : "ok"}`);
  }
  if (tmpVault) {
    rmSync(tmpVault, { recursive: true, force: true });
    console.log(`  tmpVault removed`);
  }
}

if (fail > 0) process.exit(1);
