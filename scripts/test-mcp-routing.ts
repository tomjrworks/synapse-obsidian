/**
 * Stage 1 T6.1 — /mcp routes via getBackend(workspaceId) smoke.
 *
 * Provisions a test user + workspace + tenant_keys, spawns the HTTP server
 * with OWNER_WORKSPACE_ID set to the test workspace, drives a real OAuth
 * 2.1 + PKCE handshake against /register + /authorize + /token to obtain a
 * bearer token, then exercises the /mcp MCP path and asserts that a tool
 * call lands in the workspace-scoped encrypted mirror (vault_files row +
 * Storage object + decrypt round-trip).
 *
 * The OAuth flow here uses the existing OWNER_PASSWORD gate (current Stage
 * 1 reality). T6.3 will swap that for Supabase Auth (email + password) and
 * T6.4 will derive workspaceId from the bearer instead of the env var.
 * Until then this smoke isolates to "is the right backend being routed?"
 *
 * Run: tsx scripts/test-mcp-routing.ts
 *   Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TAPROOT_KEK in env.
 */
import { createClient } from "@supabase/supabase-js";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDek, wrapDek } from "../src/api/crypto.js";
import { SupabaseEncryptedMirrorBackend } from "../src/utils/supabase-mirror.js";
import { clearAll as clearBackendCache } from "../src/utils/backend-cache.js";
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

const PORT = 3877; // distinct from onboarding smoke (3779) so they can coexist
const BASE = `http://localhost:${PORT}`;
const TEST_USER_PASSWORD = "t6-1-pw-12345";
const testEmail = `t6-1-${Date.now()}@taproot-test.local`;
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
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// OAuth 2.1 + PKCE handshake against the running server. Mirrors what
// claude.ai does in production. /authorize POSTs email + password against
// Supabase Auth (T6.2); /token mints a workspace-bound bearer.
async function obtainBearer(): Promise<string> {
  // 1. /register — dynamic client registration
  const reg = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "t6-1-smoke-client",
      redirect_uris: ["http://localhost/oauth/callback"],
    }),
  });
  if (!reg.ok) throw new Error(`/register failed: ${reg.status}`);
  const { client_id } = await reg.json();

  // 2. PKCE pair
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  // 3. /authorize — POST the form directly (skip the HTML render).
  // Server returns a 302 with `code` in the redirect URL.
  const authForm = new URLSearchParams({
    client_id,
    redirect_uri: "http://localhost/oauth/callback",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state: "t6-1-state",
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
    const body = await authRes.text();
    throw new Error(
      `/authorize expected 302, got ${authRes.status}: ${body.slice(0, 200)}`,
    );
  }
  const location = authRes.headers.get("location") ?? "";
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error(`/authorize redirect missing code: ${location}`);

  // 4. /token — exchange code for bearer
  const tokenForm = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: "http://localhost/oauth/callback",
    client_id,
    code_verifier: codeVerifier,
  });
  const tokenRes = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenForm.toString(),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    throw new Error(`/token failed ${tokenRes.status}: ${body.slice(0, 200)}`);
  }
  const { access_token } = await tokenRes.json();
  if (!access_token) throw new Error(`/token returned no access_token`);
  return access_token;
}

let bearer = "";

async function mcpCall(method: string, params: unknown): Promise<any> {
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1e9),
      method,
      params,
    }),
  });
  const text = await r.text();
  // StreamableHTTP returns SSE-framed JSON. Parse the data: line if present.
  if (text.startsWith("event:") || text.includes("\ndata: ")) {
    const dataLine = text
      .split("\n")
      .find((l) => l.startsWith("data: "))
      ?.slice("data: ".length);
    if (dataLine) return { status: r.status, json: JSON.parse(dataLine) };
  }
  try {
    return { status: r.status, json: JSON.parse(text) };
  } catch {
    return { status: r.status, text };
  }
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
      p_workspace_name: "t6-1-smoke",
      p_wrapped_dek: wrappedParam,
    },
  );
  if (wsErr) throw wsErr;
  workspaceId = wsData as string;
  check(
    "atomic signup RPC returns workspace_id",
    typeof workspaceId === "string",
  );

  console.log(`\n→ Spawning server (port ${PORT}, workspace ${workspaceId})`);

  tmpVault = mkdtempSync(join(tmpdir(), "taproot-mcp-routing-"));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OWNER_WORKSPACE_ID: workspaceId,
    PORT: String(PORT),
  };
  // T6.2: SYNAPSE_PASSWORD env var is no longer respected — auth uses
  // Supabase signInWithPassword. Force-clear it in case the parent shell
  // has it set, so tests aren't shadowed by stale values.
  delete env.SYNAPSE_PASSWORD;

  serverProc = spawn(
    "npx",
    ["tsx", "src/index.ts", tmpVault, "--http", "--port", String(PORT)],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  // Surface server output if the smoke fails; otherwise stay quiet.
  const serverLogs: string[] = [];
  serverProc.stdout?.on("data", (d) => serverLogs.push(`[stdout] ${d}`));
  serverProc.stderr?.on("data", (d) => serverLogs.push(`[stderr] ${d}`));

  const healthy = await waitForHealth(BASE);
  if (!healthy) {
    console.error("Server never became healthy. Recent output:");
    console.error(serverLogs.slice(-20).join(""));
    throw new Error("server boot failed");
  }
  check("server up at /health", true);

  console.log("\n→ OAuth handshake (register → authorize → token)");

  bearer = await obtainBearer();
  check("bearer token obtained via OAuth + PKCE", bearer.length > 0);

  // Negative: missing bearer should 401 (proves the gate is on)
  const noAuth = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
  check("POST /mcp without bearer → 401", noAuth.status === 401);

  console.log("\n→ MCP initialize handshake");

  const init = await mcpCall("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t6-1-smoke", version: "0.0.1" },
  });
  check(
    "POST /mcp initialize returns 200 + result.serverInfo.name=taproot",
    init.status === 200 && init.json?.result?.serverInfo?.name === "taproot",
    init,
  );

  console.log("\n→ tools/call garden_plant — exercise the encrypted mirror");

  const planted = await mcpCall("tools/call", {
    name: "garden_plant",
    arguments: {
      path: "inbox/t6-1-smoke.md",
      content: "# t6-1 smoke\n\nrouted via getBackend(workspaceId)\n",
    },
  });
  check(
    "tools/call garden_plant returns 200 (no isError)",
    planted.status === 200 &&
      planted.json?.result &&
      !planted.json.result.isError,
    planted,
  );

  console.log("\n→ Verify the write landed in the workspace-scoped mirror");

  const { data: rows, error: rowsErr } = await sb
    .from("vault_files")
    .select("id, path, storage_object, size_bytes, deleted_at")
    .eq("workspace_id", workspaceId)
    .eq("path", "inbox/t6-1-smoke.md")
    .is("deleted_at", null);
  check(
    "vault_files row exists for the planted path",
    !rowsErr && rows?.length === 1,
    rowsErr ?? rows,
  );

  const fileRow = rows?.[0];
  check(
    "vault_files.size_bytes is plaintext byte length (>0)",
    typeof fileRow?.size_bytes === "number" && fileRow.size_bytes > 0,
    fileRow?.size_bytes,
  );

  // Storage object check — list and find by storage_object key
  if (fileRow?.storage_object) {
    const { data: dl, error: dlErr } = await sb.storage
      .from("vault-blobs")
      .download(fileRow.storage_object);
    check("Storage object exists at storage_object key", !dlErr && !!dl, dlErr);
  } else {
    check("Storage object exists at storage_object key", false, "no row");
  }

  // Round-trip decrypt: read back through the backend, assert content matches.
  // Clear cache so we get a fresh DEK unwrap (proves the path works clean).
  clearBackendCache();
  const backend =
    await SupabaseEncryptedMirrorBackend.forWorkspace(workspaceId);
  const readBack = await backend.readFile("inbox/t6-1-smoke.md");
  check(
    "readFile via fresh backend decrypts to expected content",
    readBack.includes("routed via getBackend(workspaceId)"),
    readBack.slice(0, 80),
  );

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
    // Give it a tick to shut down; not required for correctness.
    await new Promise((r) => setTimeout(r, 200));
  }
  if (workspaceId) {
    try {
      await nukeWorkspace(sb, workspaceId, userId ?? "system");
      console.log(`  nukeWorkspace: ok`);
    } catch (e: any) {
      console.log(`  nukeWorkspace: ${e.message}`);
    }
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
