/**
 * Stage 1 T6.2 — Supabase Auth in /authorize smoke.
 *
 * Provisions a test user + workspace, spawns the HTTP server, and exercises
 * the /authorize POST handler's negative paths. The positive path (full
 * handshake → /mcp tool call) is covered by `test-mcp-routing.ts`; this
 * smoke focuses on the credential-validation surface that's specific to
 * the Supabase Auth bridge.
 *
 * Run: tsx scripts/test-oauth-supabase-bridge.ts
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

const PORT = 3878;
const BASE = `http://localhost:${PORT}`;
const TEST_USER_PASSWORD = "t6-2-pw-12345";
const testEmail = `t6-2-${Date.now()}@taproot-test.local`;
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

async function registerClient(): Promise<string> {
  const reg = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "t6-2-smoke-client",
      redirect_uris: ["http://localhost/oauth/callback"],
    }),
  });
  if (!reg.ok) throw new Error(`/register failed: ${reg.status}`);
  const { client_id } = await reg.json();
  return client_id;
}

interface AuthorizePostResult {
  status: number;
  location: string | null;
  bodySnippet: string;
}

async function postAuthorize(
  fields: Record<string, string>,
): Promise<AuthorizePostResult> {
  const form = new URLSearchParams(fields);
  const r = await fetch(`${BASE}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "manual",
  });
  const text = await r.text();
  return {
    status: r.status,
    location: r.headers.get("location"),
    bodySnippet: text.slice(0, 400),
  };
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
      p_workspace_name: "t6-2-smoke",
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
  tmpVault = mkdtempSync(join(tmpdir(), "taproot-oauth-bridge-"));
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

  const clientId = await registerClient();
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  const baseFields = {
    client_id: clientId,
    redirect_uri: "http://localhost/oauth/callback",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state: "t6-2-state",
  };

  console.log("\n→ Negative: missing email or password");
  const noEmail = await postAuthorize({
    ...baseFields,
    email: "",
    password: TEST_USER_PASSWORD,
  });
  check("POST /authorize without email → 400", noEmail.status === 400, noEmail);
  const noPassword = await postAuthorize({
    ...baseFields,
    email: testEmail,
    password: "",
  });
  check(
    "POST /authorize without password → 400",
    noPassword.status === 400,
    noPassword,
  );

  console.log("\n→ Negative: wrong password");
  const wrongPw = await postAuthorize({
    ...baseFields,
    email: testEmail,
    password: "wrong-password-xxxxx",
  });
  check(
    "POST /authorize with wrong password → 403",
    wrongPw.status === 403,
    wrongPw,
  );
  check(
    "wrong-password page renders Sign-in failed message",
    wrongPw.bodySnippet.includes("Sign-in failed"),
    wrongPw.bodySnippet,
  );

  console.log("\n→ Negative: nonexistent email");
  const noUser = await postAuthorize({
    ...baseFields,
    email: `nonexistent-${Date.now()}@taproot-test.local`,
    password: TEST_USER_PASSWORD,
  });
  check(
    "POST /authorize with unknown email → 403 (no user disclosure)",
    noUser.status === 403,
    noUser,
  );

  console.log("\n→ Positive: correct credentials → 302 with code");
  const ok = await postAuthorize({
    ...baseFields,
    email: testEmail,
    password: TEST_USER_PASSWORD,
  });
  check(
    "POST /authorize with correct credentials → 302",
    ok.status === 302,
    ok,
  );
  const code = ok.location && new URL(ok.location).searchParams.get("code");
  check(
    "302 redirect carries an authorization code",
    typeof code === "string" && code.length > 0,
    ok.location,
  );

  if (code) {
    console.log("\n→ Token exchange → bearer carries workspace binding");
    const tokenForm = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: baseFields.redirect_uri,
      client_id: clientId,
      code_verifier: codeVerifier,
    });
    const tokenRes = await fetch(`${BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenForm.toString(),
    });
    const tokenJson = await tokenRes.json();
    check(
      "POST /token returns 200 + access_token + 30d expires_in",
      tokenRes.status === 200 &&
        typeof tokenJson?.access_token === "string" &&
        tokenJson?.token_type === "Bearer" &&
        tokenJson?.expires_in === 30 * 86400,
      { status: tokenRes.status, json: tokenJson },
    );

    // The bearer is opaque to us — but exercising it against /mcp proves
    // the binding wired correctly through to getBackend(workspaceId).
    const bearer = tokenJson.access_token;
    const mcpRes = await fetch(`${BASE}/mcp`, {
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
          clientInfo: { name: "t6-2-smoke", version: "0.0.1" },
        },
      }),
    });
    check(
      "bearer issued by /authorize+/token authenticates /mcp",
      mcpRes.status === 200,
      mcpRes.status,
    );
  }

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
    } catch {
      /* best-effort */
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
