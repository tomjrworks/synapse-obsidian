/**
 * /security-audit C1 + C2-GET + C4 regression smoke (Apr 30 2026).
 *
 * Lightweight — does NOT need Supabase env. The assertions all hit code
 * paths that fail BEFORE any Supabase call (/register, /authorize GET,
 * /authorize-form-render escape). Runs the existing src/index.ts HTTP
 * server in --http mode against a tmp vault.
 *
 * Covers:
 *   - C1: escapeHtml renders attacker payload as inert text
 *   - C1: /register rejects oversized client_name
 *   - C1: /register rejects control chars in client_name
 *   - C2: /authorize GET rejects missing code_challenge
 *   - C2: /authorize GET rejects non-S256 code_challenge_method
 *   - C4: /authorize GET rejects redirect_uri not in registered allowlist
 *
 * The C2 token-side assertion (omit code_verifier at /token) is in
 * test-oauth-supabase-bridge.ts because it needs a real auth code from a
 * Supabase-backed sign-in. The C3 helper-side fix is covered by Swift
 * unit tests in helper-mac/Tests/TaprootHelperTests/AppDelegateTests.swift.
 *
 * Run: tsx scripts/test-oauth-security.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 3879);
const BASE = `http://localhost:${PORT}`;

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

async function waitForHealth(url: string, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return true;
    } catch {
      /* server still booting */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

interface RegisteredClient {
  client_id: string;
  redirect_uris: string[];
}

async function registerClient(body: unknown): Promise<Response> {
  return fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function authorizeGet(
  params: Record<string, string | undefined>,
): Promise<{ status: number; body: string }> {
  const url = new URL(`${BASE}/authorize`);
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string") url.searchParams.set(k, v);
  }
  const r = await fetch(url.toString(), { redirect: "manual" });
  return { status: r.status, body: await r.text() };
}

let serverProc: ChildProcess | null = null;
let tmpVault: string | null = null;

try {
  console.log(`\n→ Spawning server (port ${PORT})`);
  tmpVault = mkdtempSync(join(tmpdir(), "taproot-oauth-security-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(PORT),
    TAPROOT_DISABLE_RATE_LIMIT: "1",
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
    console.error(serverLogs.slice(-30).join(""));
    throw new Error("server boot failed");
  }
  check("server up at /health", true);

  // --- C1 — XSS escape on /authorize HTML body ---
  console.log("\n→ C1: client_name with HTML payload renders escaped");
  const xssPayload = "<script>alert('xss')</script>";
  const xssReg = await registerClient({
    client_name: xssPayload,
    redirect_uris: ["https://legit.example/cb"],
  });
  check("/register accepts well-formed payload (incl. < and >)", xssReg.ok);
  const xssRegBody = (await xssReg.json()) as RegisteredClient;
  const xssGet = await authorizeGet({
    client_id: xssRegBody.client_id,
    redirect_uri: "https://legit.example/cb",
    response_type: "code",
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
    state: "xss-test",
  });
  check(
    "/authorize GET escapes < and > in client_name",
    xssGet.status === 200 &&
      xssGet.body.includes("&lt;script&gt;") &&
      !xssGet.body.includes("<script>alert("),
    {
      status: xssGet.status,
      hasEscaped: xssGet.body.includes("&lt;script&gt;"),
      hasLiveTag: xssGet.body.includes("<script>alert("),
    },
  );

  // --- C1 — /register guards ---
  console.log("\n→ C1: /register rejects oversized client_name");
  const oversized = await registerClient({
    client_name: "a".repeat(201),
    redirect_uris: ["https://legit.example/cb"],
  });
  check(
    "POST /register with 201-char client_name → 400",
    oversized.status === 400,
    oversized.status,
  );

  console.log("\n→ C1: /register rejects control chars in client_name");
  const ctrl = await registerClient({
    client_name: "ok\x07bell",
    redirect_uris: ["https://legit.example/cb"],
  });
  check(
    "POST /register with \\x07 in client_name → 400",
    ctrl.status === 400,
    ctrl.status,
  );

  console.log("\n→ C1: /register rejects empty client_name");
  const empty = await registerClient({
    client_name: "",
    redirect_uris: ["https://legit.example/cb"],
  });
  check(
    "POST /register with empty client_name → 400",
    empty.status === 400,
    empty.status,
  );

  console.log("\n→ C1: /register rejects missing client_name");
  const missing = await registerClient({
    redirect_uris: ["https://legit.example/cb"],
  });
  check(
    "POST /register without client_name → 400",
    missing.status === 400,
    missing.status,
  );

  // --- Set up a clean client for C2/C4 negative cases ---
  console.log("\n→ Provisioning a benign client for C2/C4 GET-side gates");
  const goodReg = await registerClient({
    client_name: "C2-C4-Smoke-Client",
    redirect_uris: ["https://legit.example/cb"],
  });
  check("/register benign client succeeds", goodReg.ok);
  const goodClient = (await goodReg.json()) as RegisteredClient;

  // --- C2 — PKCE GET-side gates ---
  console.log("\n→ C2: /authorize GET without code_challenge → 400");
  const noChallenge = await authorizeGet({
    client_id: goodClient.client_id,
    redirect_uri: "https://legit.example/cb",
    response_type: "code",
    code_challenge_method: "S256",
    state: "no-challenge",
  });
  check(
    "/authorize without code_challenge → 400",
    noChallenge.status === 400 && noChallenge.body.includes("code_challenge"),
    { status: noChallenge.status, snippet: noChallenge.body.slice(0, 200) },
  );

  console.log("\n→ C2: /authorize GET with code_challenge_method=plain → 400");
  const plainMethod = await authorizeGet({
    client_id: goodClient.client_id,
    redirect_uri: "https://legit.example/cb",
    response_type: "code",
    code_challenge: "a".repeat(43),
    code_challenge_method: "plain",
    state: "plain-method",
  });
  check(
    "/authorize with method=plain → 400",
    plainMethod.status === 400 && plainMethod.body.includes("S256"),
    {
      status: plainMethod.status,
      snippet: plainMethod.body.slice(0, 200),
    },
  );

  console.log("\n→ C2: /authorize GET without code_challenge_method → 400");
  const noMethod = await authorizeGet({
    client_id: goodClient.client_id,
    redirect_uri: "https://legit.example/cb",
    response_type: "code",
    code_challenge: "a".repeat(43),
    state: "no-method",
  });
  check(
    "/authorize without code_challenge_method → 400",
    noMethod.status === 400,
    noMethod.status,
  );

  // --- C4 — redirect_uri allowlist ---
  console.log("\n→ C4: /authorize GET with unregistered redirect_uri → 400");
  const wrongRedirect = await authorizeGet({
    client_id: goodClient.client_id,
    redirect_uri: "https://evil.example/cb",
    response_type: "code",
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
    state: "wrong-redirect",
  });
  check(
    "/authorize with redirect_uri not in allowlist → 400",
    wrongRedirect.status === 400 && wrongRedirect.body.includes("redirect_uri"),
    {
      status: wrongRedirect.status,
      snippet: wrongRedirect.body.slice(0, 200),
    },
  );

  // --- Positive sanity: well-formed GET still renders the form ---
  console.log("\n→ Positive: well-formed /authorize GET still renders form");
  const goodGet = await authorizeGet({
    client_id: goodClient.client_id,
    redirect_uri: "https://legit.example/cb",
    response_type: "code",
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
    state: "positive",
  });
  check(
    "/authorize with valid params → 200 with approval form",
    goodGet.status === 200 && goodGet.body.includes('name="email"'),
    { status: goodGet.status, snippet: goodGet.body.slice(0, 200) },
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
  if (tmpVault) {
    rmSync(tmpVault, { recursive: true, force: true });
    console.log(`  tmpVault removed`);
  }
}

if (fail > 0) process.exit(1);
