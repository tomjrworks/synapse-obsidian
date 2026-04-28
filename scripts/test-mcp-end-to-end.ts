/**
 * Stage 1 T6.4 — /mcp end-to-end multi-workspace isolation smoke.
 *
 * Provisions two independent users (A + B) with their own workspaces +
 * DEKs, spawns ONE HTTP server, drives independent OAuth handshakes, and
 * asserts:
 *   - bearer A → /mcp → vault_files row in workspace A only
 *   - bearer B → /mcp → vault_files row in workspace B only
 *   - bearer A's token does NOT see workspace B's files (and vice versa)
 *
 * This is the load-bearing T6 invariant: the workspace_id flows from the
 * oauth_tokens row into req.workspaceId into getBackend(...), and there
 * is no path by which a token issued for one workspace can write to or
 * read from another.
 *
 * Run: tsx scripts/test-mcp-end-to-end.ts
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

const PORT = 3880;
const BASE = `http://localhost:${PORT}`;
const PASSWORD = "t6-4-pw-12345";

interface Tenant {
  email: string;
  userId: string;
  workspaceId: string;
}

async function provisionTenant(suffix: string): Promise<Tenant> {
  const email = `t6-4-${suffix}-${Date.now()}@taproot-test.local`;
  const { data: userData, error: userErr } = await sb.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (userErr || !userData.user) throw userErr ?? new Error("no user");
  const userId = userData.user.id;
  const wrappedParam = `\\x${wrapDek(generateDek()).toString("hex")}`;
  const { data: ws, error: wsErr } = await sb.rpc(
    "create_workspace_for_new_user",
    {
      p_user_id: userId,
      p_workspace_name: `t6-4-${suffix}`,
      p_wrapped_dek: wrappedParam,
    },
  );
  if (wsErr) throw wsErr;
  return { email, userId, workspaceId: ws as string };
}

async function obtainBearer(email: string): Promise<string> {
  const reg = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: `t6-4-client-${email}`,
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
    state: "t6-4",
    email,
    password: PASSWORD,
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
  return access_token;
}

async function plant(bearer: string, path: string, content: string) {
  return mcpCall(bearer, "tools/call", {
    name: "garden_plant",
    arguments: { path, content },
  });
}

async function mcpCall(
  bearer: string,
  method: string,
  params: unknown,
): Promise<{ status: number; json: any }> {
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
    return { status: r.status, json: text };
  }
}

async function waitForHealth(timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

let serverProc: ChildProcess | null = null;
let tmpVault: string | null = null;
const tenants: Tenant[] = [];

try {
  console.log("\n→ Provisioning two independent tenants");
  const A = await provisionTenant("A");
  tenants.push(A);
  check("tenant A provisioned", typeof A.workspaceId === "string");
  const B = await provisionTenant("B");
  tenants.push(B);
  check("tenant B provisioned", typeof B.workspaceId === "string");
  check(
    "tenant A and B have distinct workspace_ids",
    A.workspaceId !== B.workspaceId,
  );

  console.log(`\n→ Spawning server (port ${PORT})`);
  tmpVault = mkdtempSync(join(tmpdir(), "taproot-mcp-e2e-"));
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(PORT) };
  delete env.SYNAPSE_PASSWORD;
  serverProc = spawn(
    "npx",
    ["tsx", "src/index.ts", tmpVault, "--http", "--port", String(PORT)],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const logs: string[] = [];
  serverProc.stdout?.on("data", (d) => logs.push(`[stdout] ${d}`));
  serverProc.stderr?.on("data", (d) => logs.push(`[stderr] ${d}`));
  if (!(await waitForHealth())) {
    console.error(logs.slice(-20).join(""));
    throw new Error("server boot failed");
  }
  check("server up at /health", true);

  console.log("\n→ Obtain bearers via independent OAuth handshakes");
  const bearerA = await obtainBearer(A.email);
  const bearerB = await obtainBearer(B.email);
  check(
    "bearers issued for both tenants",
    bearerA.length > 0 && bearerB.length > 0,
  );
  check(
    "bearers are distinct opaque tokens",
    bearerA !== bearerB,
    `A=${bearerA.slice(0, 6)} B=${bearerB.slice(0, 6)}`,
  );

  console.log("\n→ Each bearer writes to its own workspace");
  const planted = await plant(bearerA, "inbox/from-A.md", "# from tenant A\n");
  check(
    "plant via bearer A returns 200 (no isError)",
    planted.status === 200 && !planted.json?.result?.isError,
    planted,
  );
  const plantedB = await plant(bearerB, "inbox/from-B.md", "# from tenant B\n");
  check(
    "plant via bearer B returns 200 (no isError)",
    plantedB.status === 200 && !plantedB.json?.result?.isError,
    plantedB,
  );

  console.log("\n→ Workspace isolation: no cross-pollination in vault_files");
  const { data: rowsA } = await sb
    .from("vault_files")
    .select("path")
    .eq("workspace_id", A.workspaceId)
    .is("deleted_at", null);
  const { data: rowsB } = await sb
    .from("vault_files")
    .select("path")
    .eq("workspace_id", B.workspaceId)
    .is("deleted_at", null);
  check(
    "workspace A has 'inbox/from-A.md' and NOT 'inbox/from-B.md'",
    Array.isArray(rowsA) &&
      rowsA.some((r) => r.path === "inbox/from-A.md") &&
      !rowsA.some((r) => r.path === "inbox/from-B.md"),
    rowsA,
  );
  check(
    "workspace B has 'inbox/from-B.md' and NOT 'inbox/from-A.md'",
    Array.isArray(rowsB) &&
      rowsB.some((r) => r.path === "inbox/from-B.md") &&
      !rowsB.some((r) => r.path === "inbox/from-A.md"),
    rowsB,
  );

  console.log(
    "\n→ Bearer A reading 'from-B.md' must NOT find workspace B's row",
  );
  // garden_read returns isError on miss in this workspace's vault_files.
  // The fact that B wrote a file at the SAME relative path means the
  // strongest test is: A trying to read 'from-B.md' should miss because
  // workspace A doesn't have a row at that path (only workspace B does).
  const readMiss = await mcpCall(bearerA, "tools/call", {
    name: "garden_read",
    arguments: { path: "inbox/from-B.md" },
  });
  const readMissText: string = readMiss.json?.result?.content?.[0]?.text ?? "";
  check(
    "bearer A read of 'inbox/from-B.md' returns isError (file not in A's vault)",
    readMiss.json?.result?.isError === true,
    {
      isError: readMiss.json?.result?.isError,
      text: readMissText.slice(0, 80),
    },
  );

  console.log("\n→ Bearer A reading its OWN file works");
  const readHit = await mcpCall(bearerA, "tools/call", {
    name: "garden_read",
    arguments: { path: "inbox/from-A.md" },
  });
  const readHitText: string = readHit.json?.result?.content?.[0]?.text ?? "";
  check(
    "bearer A read of 'inbox/from-A.md' returns content",
    readHit.json?.result?.isError !== true &&
      readHitText.includes("from tenant A"),
    readHitText.slice(0, 80),
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
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const t of tenants) {
    try {
      await nukeWorkspace(sb, t.workspaceId, t.userId);
    } catch {}
    await sb.from("workspaces").delete().eq("id", t.workspaceId);
    await sb.auth.admin.deleteUser(t.userId);
  }
  console.log(`  cleaned up ${tenants.length} tenants`);
  if (tmpVault) {
    rmSync(tmpVault, { recursive: true, force: true });
  }
}

if (fail > 0) process.exit(1);
