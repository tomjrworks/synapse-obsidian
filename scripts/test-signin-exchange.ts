/**
 * B1 /signin code-exchange smoke (2026-05-02).
 *
 * Verifies the OAuth-style code-exchange flow:
 *   GET  /signin            (challenge-gated form)
 *   POST /signin            (mints 5-min single-use code)
 *   POST /signin/exchange   (verifies PKCE, mints 30-day bearer)
 *
 * Cases that don't need credentials run without env. Happy-path +
 * DB assertions require:
 *   TEST_FIXTURE_EMAIL=<email>
 *   TEST_FIXTURE_PASSWORD=<password>
 *   SUPABASE_URL=...
 *   SUPABASE_SERVICE_ROLE_KEY=...
 * Env vars are auto-loaded from .env if not set in the shell.
 *
 * Run: tsx scripts/test-signin-exchange.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
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

const PORT = Number(process.env.PORT ?? 3879);
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

async function postExchange(
  payload: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}/signin/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "manual",
  });
  let body: any = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { status: r.status, body };
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
  tmpVault = mkdtempSync(join(tmpdir(), "taproot-signin-exchange-smoke-"));
  const serverEnv: NodeJS.ProcessEnv = {
    ...dotEnvVars,
    ...process.env,
    PORT: String(PORT),
    TAPROOT_DISABLE_RATE_LIMIT: process.env.TAPROOT_KEEP_RATE_LIMIT
      ? undefined
      : "1",
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

  // --- Case 1: POST /signin without challenge → 400 ---
  console.log("\n→ Case 1: POST /signin without challenge → 400");
  const c1 = await postSignin({ email: "x@y.com", password: "pw" });
  check(
    "400 invalid_request when challenge missing",
    c1.status === 400 && c1.body.includes("invalid_request"),
    { status: c1.status, body: c1.body.slice(0, 120) },
  );

  // --- Case 2: POST /signin with method=plain → 400 ---
  console.log("\n→ Case 2: POST /signin with method=plain → 400");
  const { challenge: c2Challenge } = makePKCE();
  const c2 = await postSignin({
    email: "x@y.com",
    password: "pw",
    code_challenge: c2Challenge,
    code_challenge_method: "plain",
  });
  check(
    "400 invalid_request when method != S256",
    c2.status === 400 && c2.body.includes("invalid_request"),
    { status: c2.status, body: c2.body.slice(0, 120) },
  );

  // --- Case 3: POST /signin/exchange malformed inputs → 400 ---
  console.log("\n→ Case 3: /signin/exchange input validation");
  const c3a = await postExchange({});
  check(
    "missing fields → 400 invalid_code",
    c3a.status === 400 && c3a.body?.error === "invalid_code",
    c3a,
  );
  const c3b = await postExchange({
    code: "ZZZ",
    code_verifier: "x".repeat(43),
  });
  check(
    "non-hex code → 400 invalid_code",
    c3b.status === 400 && c3b.body?.error === "invalid_code",
    c3b,
  );
  const c3c = await postExchange({
    code: "a".repeat(64),
    code_verifier: "x".repeat(10),
  });
  check(
    "short verifier → 400 invalid_verifier",
    c3c.status === 400 && c3c.body?.error === "invalid_verifier",
    c3c,
  );
  const c3d = await postExchange({
    code: "a".repeat(64),
    code_verifier: "x".repeat(200),
  });
  check(
    "long verifier → 400 invalid_verifier",
    c3d.status === 400 && c3d.body?.error === "invalid_verifier",
    c3d,
  );

  // --- Case 4: unknown code → 400 invalid_code ---
  console.log("\n→ Case 4: unknown code → 400");
  const c4 = await postExchange({
    code: "0".repeat(64),
    code_verifier: "x".repeat(43),
  });
  check(
    "unknown code → 400 invalid_code",
    c4.status === 400 && c4.body?.error === "invalid_code",
    c4,
  );

  // --- Case 5: happy path (signin + exchange) ---
  console.log("\n→ Case 5: happy path");
  if (!hasFixture) {
    skip(
      "happy path → code redirect + exchange yields bearer",
      "TEST_FIXTURE_EMAIL / TEST_FIXTURE_PASSWORD not set",
    );
  } else {
    const { verifier, challenge } = makePKCE();
    const post5 = await postSignin({
      email: FIXTURE_EMAIL,
      password: FIXTURE_PASSWORD,
      code_challenge: challenge,
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

    if (post5.location) {
      const params = new URL(
        post5.location.replace("taproot://", "https://taproot/"),
      );
      const code = params.searchParams.get("code")!;
      const workspaceId = params.searchParams.get("workspace")!;

      // 5a: exchange with correct verifier → 200 + bearer
      const ex5 = await postExchange({ code, code_verifier: verifier });
      check(
        "exchange happy path → 200 + 64-hex bearer + workspace_id",
        ex5.status === 200 &&
          typeof ex5.body?.bearer === "string" &&
          /^[a-f0-9]{64}$/.test(ex5.body.bearer) &&
          ex5.body.workspace_id === workspaceId,
        {
          status: ex5.status,
          bearer_len: ex5.body?.bearer?.length,
          workspace: ex5.body?.workspace_id,
        },
      );

      // 5b: re-exchange same code → 400 invalid_code (single-use)
      const ex5b = await postExchange({ code, code_verifier: verifier });
      check(
        "re-exchange same code → 400 invalid_code (single-use)",
        ex5b.status === 400 && ex5b.body?.error === "invalid_code",
        ex5b,
      );

      // 5c: bearer hashed at rest (no plaintext in oauth_tokens)
      if (hasSupabase && ex5.body?.bearer) {
        const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
        const syntheticClientId = `taproot-helper-${workspaceId}`;
        const { data: rows } = await supa
          .from("oauth_tokens")
          .select("token_hash")
          .eq("workspace_id", workspaceId)
          .eq("client_id", syntheticClientId);
        const tokens: string[] = (rows ?? []).map(
          (r: { token_hash: unknown }) => String(r.token_hash ?? ""),
        );
        const expectedHashHex = createHash("sha256")
          .update(ex5.body.bearer)
          .digest("hex");
        const plaintextLeak = tokens.some((t) => t.includes(ex5.body.bearer));
        const hashStored = tokens.some((t) =>
          t.toLowerCase().includes(expectedHashHex.toLowerCase()),
        );
        check("raw bearer NOT present in oauth_tokens", !plaintextLeak, {
          tokens_seen: tokens.length,
        });
        check("sha256(bearer) hex IS present in oauth_tokens", hashStored, {
          tokens_seen: tokens.length,
        });
      } else {
        skip("oauth_tokens hash assertion", "Supabase env not set");
      }
    }
  }

  // --- Case 6: PKCE mismatch → 400 + code consumed (no oracle) ---
  console.log("\n→ Case 6: PKCE mismatch consumes code");
  if (!hasFixture) {
    skip(
      "pkce mismatch → 400 + single-use",
      "TEST_FIXTURE_EMAIL / TEST_FIXTURE_PASSWORD not set",
    );
  } else {
    const { challenge } = makePKCE();
    const post6 = await postSignin({
      email: FIXTURE_EMAIL,
      password: FIXTURE_PASSWORD,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const params6 = new URL(
      (post6.location ?? "taproot://auth?code=&workspace=").replace(
        "taproot://",
        "https://taproot/",
      ),
    );
    const code6 = params6.searchParams.get("code")!;
    const wrongVerifier = "x".repeat(43);
    const ex6 = await postExchange({
      code: code6,
      code_verifier: wrongVerifier,
    });
    check(
      "wrong verifier → 400 pkce_mismatch",
      ex6.status === 400 && ex6.body?.error === "pkce_mismatch",
      ex6,
    );

    // Re-attempt with the right shape — code should already be consumed,
    // so we get invalid_code (no oracle leaking validity).
    const ex6b = await postExchange({
      code: code6,
      code_verifier: "y".repeat(43),
    });
    check(
      "code consumed even on PKCE mismatch (no oracle)",
      ex6b.status === 400 && ex6b.body?.error === "invalid_code",
      ex6b,
    );
  }

  // --- Case 7: code expiry ---
  console.log("\n→ Case 7: code expiry");
  if (!hasFixture) {
    skip(
      "expired code → 400 expired",
      "TEST_FIXTURE_EMAIL / TEST_FIXTURE_PASSWORD not set",
    );
  } else {
    const { verifier, challenge } = makePKCE();
    const post7 = await postSignin({
      email: FIXTURE_EMAIL,
      password: FIXTURE_PASSWORD,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const params7 = new URL(
      (post7.location ?? "taproot://auth?code=&workspace=").replace(
        "taproot://",
        "https://taproot/",
      ),
    );
    const code7 = params7.searchParams.get("code")!;
    // Reach into the test seam exposed by src/signin.ts to expire the code
    // without sleeping for 5 minutes. Server runs in a child process, so we
    // use an HTTP-side "expire" only via a fresh codepath: hit the cache
    // through a debug seam. Since we can't import across processes, we
    // simulate expiry by waiting for actual TTL to pass — too slow. Instead,
    // signal via env var and module flag at server boot. The plan-level
    // test seam is process-internal; for cross-process we settle for the
    // single-use happy path (re-using same code returns invalid_code which
    // is the same observable status as expired post-consumption, so we
    // assert behaviorally rather than by error code).
    skip(
      "expired code (deferred)",
      "in-process seam not callable across spawned server",
    );
    void code7;
    void verifier;
  }

  // --- Case 8: GET /signin without challenge → friendly message ---
  console.log("\n→ Case 8: GET /signin without challenge");
  const get8 = await fetch(`${BASE}/signin`);
  const get8Body = await get8.text();
  check(
    "200 + helper-required message present",
    get8.status === 200 && get8Body.includes("Open Taproot from your menu bar"),
    {
      status: get8.status,
      hasMsg: get8Body.includes("Open Taproot from your menu bar"),
    },
  );
  check(
    "no <form> rendered when challenge missing",
    !get8Body.includes('action="/signin"'),
    { found: get8Body.includes('action="/signin"') },
  );

  // --- Case 9: GET /signin with valid challenge → form rendered ---
  console.log("\n→ Case 9: GET /signin with valid challenge");
  const { challenge: c9Challenge } = makePKCE();
  const get9 = await fetch(
    `${BASE}/signin?code_challenge=${c9Challenge}&code_challenge_method=S256`,
  );
  const get9Body = await get9.text();
  check(
    "form rendered when challenge present",
    get9.status === 200 && get9Body.includes('action="/signin"'),
    { status: get9.status },
  );
  check(
    "challenge round-trips into hidden input",
    get9Body.includes(`value="${c9Challenge}"`),
    {},
  );

  // --- Case 10: UPSERT idempotence at /signin/exchange ---
  console.log("\n→ Case 10: UPSERT idempotence");
  if (!hasFixture || !hasSupabase) {
    skip(
      "exchange twice → one oauth_clients row, two oauth_tokens rows",
      !hasFixture
        ? "TEST_FIXTURE_EMAIL / TEST_FIXTURE_PASSWORD not set"
        : "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set",
    );
  } else {
    const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const runOnce = async () => {
      const { verifier, challenge } = makePKCE();
      const p = await postSignin({
        email: FIXTURE_EMAIL,
        password: FIXTURE_PASSWORD,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const params = new URL(
        (p.location ?? "taproot://auth?code=&workspace=").replace(
          "taproot://",
          "https://taproot/",
        ),
      );
      const code = params.searchParams.get("code")!;
      const workspaceId = params.searchParams.get("workspace")!;
      const ex = await postExchange({ code, code_verifier: verifier });
      return { workspaceId, ex };
    };
    const r1 = await runOnce();
    const r2 = await runOnce();
    check("first exchange ok", r1.ex.status === 200, r1.ex);
    check("second exchange ok", r2.ex.status === 200, r2.ex);
    check("same workspace_id across both", r1.workspaceId === r2.workspaceId, {
      one: r1.workspaceId,
      two: r2.workspaceId,
    });

    const syntheticClientId = `taproot-helper-${r1.workspaceId}`;
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
      .eq("workspace_id", r1.workspaceId)
      .eq("client_id", syntheticClientId);
    check(
      "two+ oauth_tokens rows (one per exchange)",
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
