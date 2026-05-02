/**
 * /signin smoke (B1 code-exchange refactor, 2026-05-02).
 *
 * Cases that don't need credentials run without env. Happy path additionally
 * requires:
 *   TEST_FIXTURE_EMAIL=<email>
 *   TEST_FIXTURE_PASSWORD=<password>
 * Env vars are auto-loaded from .env if not set in the shell.
 *
 * The deeper exchange-side coverage (PKCE mismatch, single-use, hash-at-rest,
 * UPSERT idempotence) lives in scripts/test-signin-exchange.ts.
 *
 * Run: tsx scripts/test-signin.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";

function loadDotEnv(): Record<string, string> {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return {};
  const result: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)/);
    if (m) result[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return result;
}

const dotEnvVars = loadDotEnv();

const PORT = Number(process.env.PORT ?? 3877);
const BASE = `http://localhost:${PORT}`;

let pass = 0;
let fail = 0;
let skipped = 0;
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

function skip(name: string, reason: string) {
  skipped++;
  console.log(`  ~ ${name}  (skipped: ${reason})`);
}

function makePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url"); // 43 chars
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
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

async function getSignin(
  params: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const url = new URL(`${BASE}/signin`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), { redirect: "manual" });
  return { status: r.status, body: await r.text() };
}

async function postSignin(
  body: Record<string, string>,
): Promise<{ status: number; location: string | null; body: string }> {
  const form = new URLSearchParams(body);
  const r = await fetch(`${BASE}/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "manual",
  });
  return {
    status: r.status,
    location: r.headers.get("location"),
    body: await r.text(),
  };
}

const FIXTURE_EMAIL =
  process.env.TEST_FIXTURE_EMAIL ?? dotEnvVars.TEST_FIXTURE_EMAIL ?? "";
const FIXTURE_PASSWORD =
  process.env.TEST_FIXTURE_PASSWORD ?? dotEnvVars.TEST_FIXTURE_PASSWORD ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? dotEnvVars.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  dotEnvVars.SUPABASE_SERVICE_ROLE_KEY ??
  "";
const hasFixture = Boolean(FIXTURE_EMAIL && FIXTURE_PASSWORD);
const hasSupabase = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);

let serverProc: ChildProcess | null = null;
let tmpVault: string | null = null;

try {
  console.log(`\n→ Spawning server (port ${PORT})`);
  tmpVault = mkdtempSync(join(tmpdir(), "taproot-signin-smoke-"));
  const serverEnv: NodeJS.ProcessEnv = {
    ...dotEnvVars,
    ...process.env,
    PORT: String(PORT),
  };
  serverProc = spawn(
    "npx",
    ["tsx", "src/index.ts", tmpVault, "--http", "--port", String(PORT)],
    { env: serverEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  const serverLogs: string[] = [];
  serverProc.stdout?.on("data", (d) => serverLogs.push(`[stdout] ${d}`));
  serverProc.stderr?.on("data", (d) => serverLogs.push(`[stderr] ${d}`));
  if (!(await waitForHealth(BASE))) {
    console.error(serverLogs.slice(-30).join(""));
    throw new Error("server boot failed");
  }
  check("server up at /health", true);

  // --- Case 1: GET /signin WITH challenge renders branded form ---
  console.log("\n→ Case 1: GET /signin with challenge renders form");
  const { challenge: c1Challenge } = makePKCE();
  const get1 = await getSignin({
    code_challenge: c1Challenge,
    code_challenge_method: "S256",
  });
  check(
    "200, contains Fraunces font reference",
    get1.status === 200 && get1.body.includes("Fraunces"),
    { status: get1.status },
  );
  check("contains forest-dark color token", get1.body.includes("#1A5C32"), {});
  check(
    "contains POST form targeting /signin",
    get1.body.includes('method="POST"') &&
      get1.body.includes('action="/signin"'),
    {},
  );
  check(
    "contains email + password inputs",
    get1.body.includes('name="email"') && get1.body.includes('name="password"'),
    {},
  );
  check(
    "challenge + method round-trip into hidden inputs",
    get1.body.includes(`value="${c1Challenge}"`) &&
      get1.body.includes('value="S256"'),
    {},
  );

  // --- Case 2: GET /signin re-renders with error + pre-filled email ---
  console.log("\n→ Case 2: GET /signin re-renders error");
  const { challenge: c2Challenge } = makePKCE();
  const get2 = await getSignin({
    error: "invalid_credentials",
    email: "foo@bar.com",
    code_challenge: c2Challenge,
    code_challenge_method: "S256",
  });
  check(
    "200, error banner present",
    get2.status === 200 && get2.body.includes("Invalid email or password"),
    {},
  );
  check("pre-fills email value", get2.body.includes('value="foo@bar.com"'), {});

  // --- Case 3: POST missing email → 302 with challenge preserved ---
  console.log("\n→ Case 3: POST missing email");
  const { challenge: c3Challenge } = makePKCE();
  const post3 = await postSignin({
    password: "anything",
    code_challenge: c3Challenge,
    code_challenge_method: "S256",
  });
  check(
    "302 + Location includes error=missing_email + preserves challenge",
    post3.status === 302 &&
      post3.location != null &&
      post3.location.includes("error=missing_email") &&
      post3.location.includes(`code_challenge=${c3Challenge}`) &&
      post3.location.includes("code_challenge_method=S256"),
    { status: post3.status, location: post3.location },
  );

  // --- Case 4: POST invalid creds → 302 invalid_credentials ---
  console.log("\n→ Case 4: POST invalid credentials");
  if (!hasSupabase) {
    skip(
      "invalid creds → 302 invalid_credentials",
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not available",
    );
  } else {
    const { challenge: c4Challenge } = makePKCE();
    const post4 = await postSignin({
      email: "notreal@example.com",
      password: "wrong-password-xyz",
      code_challenge: c4Challenge,
      code_challenge_method: "S256",
    });
    check(
      "302 + Location contains invalid_credentials + preserves challenge",
      post4.status === 302 &&
        post4.location != null &&
        post4.location.includes("error=invalid_credentials") &&
        post4.location.includes(`code_challenge=${c4Challenge}`),
      { status: post4.status, location: post4.location },
    );
  }

  // --- Case 5: POST happy path (requires fixture user) ---
  console.log("\n→ Case 5: POST happy path");
  if (!hasFixture) {
    skip(
      "happy path → taproot://auth?code=… deep-link redirect",
      "TEST_FIXTURE_EMAIL / TEST_FIXTURE_PASSWORD not set",
    );
  } else {
    const { challenge: c5Challenge } = makePKCE();
    const post5 = await postSignin({
      email: FIXTURE_EMAIL,
      password: FIXTURE_PASSWORD,
      code_challenge: c5Challenge,
      code_challenge_method: "S256",
    });
    const codeRedirectRe =
      /^taproot:\/\/auth\/?\?code=[a-f0-9]{64}&workspace=[0-9a-f-]{36}$/;
    check(
      "302 + Location matches taproot://auth?code=<64hex>&workspace=<uuid>",
      post5.status === 302 &&
        post5.location != null &&
        codeRedirectRe.test(post5.location),
      { status: post5.status, location: post5.location },
    );
    check(
      "no bearer= in redirect URL (B1 regression guard)",
      post5.location != null && !post5.location.includes("bearer="),
      { location: post5.location },
    );
  }

  // --- Case 6: HTML-escape sanity ---
  console.log("\n→ Case 6: HTML-escape sanity");
  const { challenge: c6Challenge } = makePKCE();
  const get6 = await getSignin({
    email: "<script>alert(1)</script>",
    code_challenge: c6Challenge,
    code_challenge_method: "S256",
  });
  check(
    "raw <script> tag absent from rendered body",
    !get6.body.includes("<script>alert(1)</script>"),
    {},
  );
  check(
    "escaped form present (&lt;script&gt;)",
    get6.body.includes("&lt;script&gt;"),
    {},
  );

  // --- Case 7: GET /signin without challenge → friendly helper-required page ---
  console.log("\n→ Case 7: GET /signin without challenge");
  const get7 = await getSignin({});
  check(
    "200 + helper-required message present",
    get7.status === 200 &&
      get7.body.includes("Open Taproot from your menu bar"),
    { status: get7.status },
  );
  check(
    "no <form> rendered when challenge missing",
    !get7.body.includes('action="/signin"'),
    {},
  );

  // --- Case 8: POST /signin without challenge → 400 ---
  console.log("\n→ Case 8: POST /signin without challenge");
  const post8 = await postSignin({ email: "x@y.com", password: "pw" });
  check(
    "400 invalid_request when challenge missing",
    post8.status === 400 && post8.body.includes("invalid_request"),
    { status: post8.status, body: post8.body.slice(0, 120) },
  );

  const skipNote = skipped > 0 ? `, ${skipped} skipped` : "";
  console.log(`\n${pass} pass, ${fail} fail${skipNote}`);
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
