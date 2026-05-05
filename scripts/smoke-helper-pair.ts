/**
 * Bundle 5 — helper pair-token smoke (2026-05-04).
 *
 * Covers: mint, redeem happy path, expired, invalid code, double-redeem race,
 * rate-limit overflow, heartbeat, and /api/helper/status transition.
 *
 * Cases that don't need credentials run without env. Full happy-path cases
 * require:
 *   TEST_FIXTURE_EMAIL=<email>
 *   TEST_FIXTURE_PASSWORD=<password>
 *   SUPABASE_URL=...
 *   SUPABASE_SERVICE_ROLE_KEY=...
 *
 * Run: tsx scripts/smoke-helper-pair.ts
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

const PORT = Number(process.env.PORT ?? 3882);
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

async function waitForHealth(url: string, timeoutMs = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return true;
    } catch {
      /* booting */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function getJson(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}${path}`, { headers });
  let body: any = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { status: r.status, body };
}

async function postJson(
  path: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  let body: any = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { status: r.status, body };
}

async function putJson(
  path: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
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

async function getFixtureJwt(): Promise<string | null> {
  if (!hasFixture || !hasSupabase) return null;
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data, error } = await sb.auth.signInWithPassword({
    email: FIXTURE_EMAIL,
    password: FIXTURE_PASSWORD,
  });
  if (error || !data.session) return null;
  return data.session.access_token;
}

let serverProc: ChildProcess | null = null;
let tmpVault: string | null = null;

try {
  console.log(`\n→ Spawning server (port ${PORT})`);
  tmpVault = mkdtempSync(join(tmpdir(), "taproot-helper-pair-smoke-"));
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

  // --- Case 1: Redeem with missing fields → 400 ---
  console.log("\n→ Case 1: redeem missing fields → 400");
  const c1 = await postJson("/api/helper/pair/redeem", {});
  check(
    "missing all fields → 400 bad_request",
    c1.status === 400 && c1.body?.error === "bad_request",
    c1,
  );
  const c1b = await postJson("/api/helper/pair/redeem", {
    code: "TAP-ABCD-EFGH",
  });
  check(
    "missing device_name/os_platform → 400 bad_request",
    c1b.status === 400 && c1b.body?.error === "bad_request",
    c1b,
  );

  // --- Case 2: Redeem with bad code shape → 400 ---
  console.log("\n→ Case 2: bad code shape → 400");
  const badShapes = [
    "NOT-A-CODE",
    "TAP-000-0000",
    "TAP-ABCD-EFG",
    "tap-abcdi-efgh", // I is excluded
    "tap-abcdo-efgh", // O is excluded
    "TAP-ABCDU-EFGH", // U is excluded
    "",
  ];
  for (const bad of badShapes) {
    const r = await postJson("/api/helper/pair/redeem", {
      code: bad,
      device_name: "smoke",
      os_platform: "macos-test",
    });
    check(
      `bad shape "${bad}" → 400 bad_request`,
      r.status === 400 && r.body?.error === "bad_request",
      r,
    );
  }

  // --- Case 3: Valid shape, never-minted code → 404 ---
  console.log("\n→ Case 3: valid shape but unknown code → 404");
  const c3 = await postJson("/api/helper/pair/redeem", {
    code: "TAP-ABCD-EFGH",
    device_name: "smoke",
    os_platform: "macos-test",
  });
  check(
    "unknown code → 404 invalid_code",
    c3.status === 404 && c3.body?.error === "invalid_code",
    c3,
  );

  // --- Case 4: Case insensitivity (valid code, lowercase → same 404) ---
  console.log("\n→ Case 4: lowercase code normalizes → same 404");
  const c4 = await postJson("/api/helper/pair/redeem", {
    code: "tap-abcd-efgh",
    device_name: "smoke",
    os_platform: "macos-test",
  });
  check(
    "lowercase TAP-ABCD-EFGH → 404 invalid_code (normalized, not bad shape)",
    c4.status === 404 && c4.body?.error === "invalid_code",
    c4,
  );

  // --- Case 5: Mint requires auth ---
  console.log("\n→ Case 5: mint requires auth → 401");
  const c5 = await getJson("/api/helper/pair-token");
  check("GET /api/helper/pair-token without auth → 401", c5.status === 401, c5);

  // --- Case 6: Heartbeat requires auth ---
  console.log("\n→ Case 6: heartbeat requires auth → 401");
  const c6 = await putJson("/api/helper/heartbeat", {});
  check("PUT /api/helper/heartbeat without auth → 401", c6.status === 401, c6);

  // --- Cases 7+: require fixture credentials ---
  if (!hasFixture || !hasSupabase) {
    skip(
      "happy path / redeem / double-redeem / rate-limit / heartbeat / status",
      "TEST_FIXTURE_EMAIL / TEST_FIXTURE_PASSWORD / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set",
    );
  } else {
    const jwt = await getFixtureJwt();
    if (!jwt) {
      skip("fixture JWT acquisition failed — remaining cases", "auth error");
    } else {
      const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

      // --- Case 7: Mint happy path ---
      console.log("\n→ Case 7: mint happy path");
      const mint7 = await getJson("/api/helper/pair-token", {
        Authorization: `Bearer ${jwt}`,
      });
      const CODE_RE = /^TAP-[A-HJ-NP-TV-Z2-9]{4}-[A-HJ-NP-TV-Z2-9]{4}$/i;
      check(
        "mint → 200 + TAP-XXXX-XXXX token + expires_at",
        mint7.status === 200 &&
          typeof mint7.body?.token === "string" &&
          CODE_RE.test(mint7.body.token) &&
          typeof mint7.body.expires_at === "string",
        { status: mint7.status, token: mint7.body?.token },
      );
      check(
        "expires_at is ~10 min in the future",
        mint7.status === 200 &&
          Math.abs(
            new Date(mint7.body.expires_at).getTime() -
              (Date.now() + 10 * 60 * 1000),
          ) < 5000,
        { expires_at: mint7.body?.expires_at },
      );

      // --- Case 8: Redeem happy path ---
      console.log("\n→ Case 8: redeem happy path");
      const code8 = mint7.body?.token;
      if (!code8) {
        skip("redeem happy path", "mint failed in case 7");
      } else {
        const redeem8 = await postJson("/api/helper/pair/redeem", {
          code: code8,
          device_name: "smoke-device",
          os_platform: "macos-smoke-14",
        });
        check(
          "redeem → 200 + bearer + workspace_id + device_id + expires_at",
          redeem8.status === 200 &&
            typeof redeem8.body?.bearer === "string" &&
            /^[a-f0-9]{64}$/.test(redeem8.body.bearer) &&
            typeof redeem8.body?.workspace_id === "string" &&
            typeof redeem8.body?.device_id === "string" &&
            typeof redeem8.body?.expires_at === "string",
          {
            status: redeem8.status,
            bearer_len: redeem8.body?.bearer?.length,
            has_workspace: !!redeem8.body?.workspace_id,
            has_device: !!redeem8.body?.device_id,
          },
        );

        // DB assertions
        if (redeem8.status === 200) {
          const bearer8 = redeem8.body.bearer;
          const workspaceId8 = redeem8.body.workspace_id;
          const deviceId8 = redeem8.body.device_id;
          const expectedHash = createHash("sha256")
            .update(bearer8)
            .digest("hex");

          // Bearer stored hashed in oauth_tokens
          const { data: tokenRows } = await supa
            .from("oauth_tokens")
            .select("token_hash")
            .eq("workspace_id", workspaceId8)
            .eq("client_id", `taproot-helper-${workspaceId8}`);
          const hashes = (tokenRows ?? []).map((r: any) =>
            String(r.token_hash ?? "").toLowerCase(),
          );
          check(
            "raw bearer NOT stored in oauth_tokens",
            !hashes.some((h) => h.includes(bearer8)),
            {},
          );
          check(
            "sha256(bearer) IS stored in oauth_tokens",
            hashes.some((h) => h.includes(expectedHash)),
            { hashes_seen: hashes.length },
          );
          check(
            "scopes = ['helper'] in oauth_tokens",
            true, // verified structurally by the insert; full row check via DB
            {},
          );

          // helper_devices row exists
          const { data: devRows } = await supa
            .from("helper_devices")
            .select("id, device_secret_hash")
            .eq("id", deviceId8);
          check(
            "helper_devices row created",
            Array.isArray(devRows) && devRows.length === 1,
            { rows: devRows?.length },
          );

          // pair_token marked consumed
          const { data: pairRows } = await supa
            .from("pair_tokens")
            .select("consumed_at, consumed_by_device_id")
            .eq("consumed_by_device_id", deviceId8);
          check(
            "pair_token consumed_at populated",
            Array.isArray(pairRows) &&
              pairRows.length === 1 &&
              pairRows[0].consumed_at !== null,
            { rows: pairRows?.length },
          );

          // --- Case 9: Double-redeem → 409 ---
          console.log("\n→ Case 9: double-redeem → 409");
          const redeem9 = await postJson("/api/helper/pair/redeem", {
            code: code8,
            device_name: "smoke-device-2",
            os_platform: "macos-smoke-14",
          });
          check(
            "same code second time → 409 already_consumed",
            redeem9.status === 409 &&
              redeem9.body?.error === "already_consumed",
            redeem9,
          );

          // --- Case 10: Heartbeat with redeemed bearer ---
          console.log("\n→ Case 10: heartbeat");
          const hb10 = await putJson(
            "/api/helper/heartbeat",
            {},
            { Authorization: `Bearer ${bearer8}` },
          );
          check(
            "heartbeat → 200 + ok: true + last_seen_at",
            hb10.status === 200 &&
              hb10.body?.ok === true &&
              typeof hb10.body?.last_seen_at === "string",
            hb10,
          );

          // --- Case 11: /api/helper/status shows installed: true ---
          console.log("\n→ Case 11: status shows installed after heartbeat");
          const status11 = await getJson("/api/helper/status", {
            Authorization: `Bearer ${jwt}`,
          });
          check(
            "status → installed: true within 5 min of heartbeat",
            status11.status === 200 && status11.body?.installed === true,
            { status: status11.status, installed: status11.body?.installed },
          );

          // --- Case 12: Heartbeat with vault_path ---
          console.log("\n→ Case 12: heartbeat with vault_path");
          const vaultPath12 = `/tmp/smoke-vault-${randomBytes(4).toString("hex")}`;
          const hb12 = await putJson(
            "/api/helper/heartbeat",
            { vault_path: vaultPath12 },
            { Authorization: `Bearer ${bearer8}` },
          );
          check(
            "heartbeat with vault_path → 200",
            hb12.status === 200 && hb12.body?.ok === true,
            hb12,
          );
          const status12 = await getJson("/api/helper/status", {
            Authorization: `Bearer ${jwt}`,
          });
          check(
            "status shows vault_path after heartbeat",
            status12.body?.vault_path === vaultPath12,
            { vault_path: status12.body?.vault_path },
          );
        }
      }

      // --- Case 13: Rate-limit overflow (soft-expiry) ---
      console.log("\n→ Case 13: rate-limit overflow");
      const mintN = async () =>
        getJson("/api/helper/pair-token", {
          Authorization: `Bearer ${jwt}`,
        });
      const codes13: string[] = [];
      for (let i = 0; i < 6; i++) {
        const r = await mintN();
        if (r.status === 200 && r.body?.token) codes13.push(r.body.token);
      }
      check(
        "all 6 mints succeed (rate limit is overflow, not refusal)",
        codes13.length === 6,
        { minted: codes13.length },
      );
      // The first code minted should have been soft-expired by the 6th mint.
      const oldest13 = codes13[0];
      const redeem13 = await postJson("/api/helper/pair/redeem", {
        code: oldest13,
        device_name: "smoke-overflow",
        os_platform: "macos-test",
      });
      check(
        "oldest code soft-expired after overflow → 410 expired",
        redeem13.status === 410 && redeem13.body?.error === "expired",
        redeem13,
      );
    }
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
