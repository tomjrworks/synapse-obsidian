/**
 * B3 cloud signin smoke (2026-05-01).
 *
 * Cases 1-3 and 6 run without Supabase env (form rendering + input validation).
 * Case 4 (invalid creds) requires Supabase to be reachable.
 * Cases 5 and 7 (happy path + UPSERT idempotence) additionally require:
 *   TEST_FIXTURE_EMAIL=<email>
 *   TEST_FIXTURE_PASSWORD=<password>
 * Env vars are auto-loaded from .env if not set in the shell.
 * Skip messages are printed for skipped cases — not failures.
 *
 * Run: tsx scripts/test-signin.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

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
): Promise<{ status: number; location: string | null }> {
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

  // --- Case 1: GET /signin renders branded form ---
  console.log("\n→ Case 1: GET /signin renders form");
  const get1 = await getSignin({});
  check(
    "200, contains Fraunces font reference",
    get1.status === 200 && get1.body.includes("Fraunces"),
    { status: get1.status },
  );
  check("contains forest-dark color token", get1.body.includes("#1A5C32"), {
    found: get1.body.includes("#1A5C32"),
  });
  check(
    "contains POST form targeting /signin",
    get1.body.includes('method="POST"') &&
      get1.body.includes('action="/signin"'),
    {
      method: get1.body.includes('method="POST"'),
      action: get1.body.includes('action="/signin"'),
    },
  );
  check(
    "contains email + password inputs",
    get1.body.includes('name="email"') && get1.body.includes('name="password"'),
    {
      email: get1.body.includes('name="email"'),
      password: get1.body.includes('name="password"'),
    },
  );

  // --- Case 2: GET /signin re-renders with error + pre-filled email ---
  console.log("\n→ Case 2: GET /signin re-renders error");
  const get2 = await getSignin({
    error: "invalid_credentials",
    email: "foo@bar.com",
  });
  check(
    "200, error banner present",
    get2.status === 200 && get2.body.includes("Invalid email or password"),
    {
      status: get2.status,
      hasBanner: get2.body.includes("Invalid email or password"),
    },
  );
  check("pre-fills email value", get2.body.includes('value="foo@bar.com"'), {
    found: get2.body.includes('value="foo@bar.com"'),
  });

  // --- Case 3: POST missing email → 302 missing_email ---
  console.log("\n→ Case 3: POST missing email");
  const post3 = await postSignin({ password: "anything" });
  check(
    "302 + Location: /signin?error=missing_email",
    post3.status === 302 && post3.location === "/signin?error=missing_email",
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
    const post4 = await postSignin({
      email: "notreal@example.com",
      password: "wrong-password-xyz",
    });
    check(
      "302 + Location contains invalid_credentials",
      post4.status === 302 &&
        post4.location != null &&
        post4.location.includes("error=invalid_credentials"),
      { status: post4.status, location: post4.location },
    );
  }

  // --- Case 5: POST happy path (requires fixture user) ---
  console.log("\n→ Case 5: POST happy path");
  if (!hasFixture) {
    skip(
      "happy path → taproot://auth deep-link redirect",
      "TEST_FIXTURE_EMAIL / TEST_FIXTURE_PASSWORD not set",
    );
  } else {
    const post5 = await postSignin({
      email: FIXTURE_EMAIL,
      password: FIXTURE_PASSWORD,
    });
    const deepLinkRe =
      /^taproot:\/\/auth\/?\?bearer=[a-f0-9]{64}&workspace=[0-9a-f-]{36}$/;
    check(
      "302 + Location matches taproot://auth?bearer=<64hex>&workspace=<uuid>",
      post5.status === 302 &&
        post5.location != null &&
        deepLinkRe.test(post5.location),
      { status: post5.status, location: post5.location },
    );

    if (hasSupabase && post5.location) {
      const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
      const params = new URL(
        post5.location.replace("taproot://", "https://taproot/"),
      );
      const workspaceId = params.searchParams.get("workspace")!;
      const syntheticClientId = `taproot-helper-${workspaceId}`;
      const { data: tokenRows } = await supa
        .from("oauth_tokens")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("client_id", syntheticClientId);
      check(
        "oauth_tokens row exists for synthetic client",
        Array.isArray(tokenRows) && tokenRows.length >= 1,
        { rows: tokenRows?.length },
      );
    } else {
      skip(
        "oauth_tokens DB assertion",
        "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set",
      );
    }
  }

  // --- Case 6: HTML-escape sanity ---
  console.log("\n→ Case 6: HTML-escape sanity");
  const get6 = await getSignin({ email: "<script>alert(1)</script>" });
  check(
    "raw <script> tag absent from rendered body",
    !get6.body.includes("<script>alert(1)</script>"),
    { found: get6.body.includes("<script>alert(1)</script>") },
  );
  check(
    "escaped form present (&lt;script&gt;)",
    get6.body.includes("&lt;script&gt;"),
    { found: get6.body.includes("&lt;script&gt;") },
  );

  // --- Case 7: UPSERT idempotence (requires fixture user) ---
  console.log("\n→ Case 7: UPSERT idempotence");
  if (!hasFixture || !hasSupabase) {
    skip(
      "POST twice → one oauth_clients row, two oauth_tokens rows",
      !hasFixture
        ? "TEST_FIXTURE_EMAIL / TEST_FIXTURE_PASSWORD not set"
        : "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set",
    );
  } else {
    const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // First signin
    const first = await postSignin({
      email: FIXTURE_EMAIL,
      password: FIXTURE_PASSWORD,
    });
    check(
      "first signin → 302",
      first.status === 302 && first.location?.includes("taproot://auth"),
      { status: first.status },
    );

    // Second signin
    const second = await postSignin({
      email: FIXTURE_EMAIL,
      password: FIXTURE_PASSWORD,
    });
    check(
      "second signin → 302",
      second.status === 302 && second.location?.includes("taproot://auth"),
      { status: second.status },
    );

    const params = new URL(
      (first.location ?? "taproot://auth?workspace=x").replace(
        "taproot://",
        "https://taproot/",
      ),
    );
    const workspaceId = params.searchParams.get("workspace")!;
    const syntheticClientId = `taproot-helper-${workspaceId}`;

    const { data: clientRows } = await supa
      .from("oauth_clients")
      .select("client_id")
      .eq("client_id", syntheticClientId);
    check(
      "exactly one oauth_clients row (UPSERT idempotent)",
      Array.isArray(clientRows) && clientRows.length === 1,
      { rows: clientRows?.length },
    );

    const { data: tokenRows } = await supa
      .from("oauth_tokens")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("client_id", syntheticClientId);
    check(
      "two oauth_tokens rows (one per signin)",
      Array.isArray(tokenRows) && tokenRows.length >= 2,
      { rows: tokenRows?.length },
    );
  }

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
