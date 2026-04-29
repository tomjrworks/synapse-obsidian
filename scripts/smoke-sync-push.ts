/**
 * Stage 1 T11.3 commit 4 — end-to-end smoke for the helper push pipeline.
 *
 * Drives the full local→cloud loop:
 *   1. provision a real Supabase tenant + workspace + DEK
 *   2. spawn the HTTP server (`tsx src/index.ts ... --http --port 3781`)
 *   3. obtain a real OAuth bearer for that workspace (helper-shaped token)
 *   4. seed the bearer into the macOS Keychain under a smoke-only service
 *   5. spawn the SwiftPM-built helper binary against an isolated tmp folder
 *      base (`TAPROOT_LOCAL_FOLDER_BASE`) so it never touches `~/Documents`
 *   6. write a file → assert it lands as a `vault_files` row + Storage blob
 *      with the expected sha256 + size
 *   7. delete the file → assert the row gets `deleted_at` set
 *   8. revoke the OAuth token in Postgres → write a third file → assert
 *      the helper signed out (Keychain entry gone)
 *
 * Cleanup runs unconditionally in `finally` and is idempotent: process kills,
 * `nukeWorkspace`, auth-user delete, keychain entry delete, tmp folder rm.
 *
 * Env (loaded by `scripts/smoke-sync-push.sh` from `<repo>/.env`):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TAPROOT_KEK            — required
 *   TAPROOT_HELPER_BINARY                                            — set by the .sh driver
 *
 * Run via: `npm run smoke:sync-push`
 */
import { createClient } from "@supabase/supabase-js";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDek, wrapDek } from "../src/api/crypto.js";
import { nukeWorkspace } from "../src/utils/supabase-mirror.js";

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const PORT = 3781;
const BASE = `http://localhost:${PORT}`;
const PASSWORD = "t11-3-smoke-pw-12345";
const KEYCHAIN_SERVICE = "com.taproot.helper.smoke";
const VAULT_BLOBS_BUCKET = "vault-blobs";
const HELPER_BINARY = process.env.TAPROOT_HELPER_BINARY ?? "";

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

interface Tenant {
  email: string;
  userId: string;
  workspaceId: string;
}

// COPY of test-mcp-end-to-end.ts:59-130 (provisionTenant + obtainBearer +
// waitForHealth). Plan §11.5 defers lifting these to scripts/lib/ until a
// third caller exists; T11.4 will trigger that refactor.
async function provisionTenant(suffix: string): Promise<Tenant> {
  const email = `t11-3-smoke-${suffix}-${Date.now()}@taproot-test.local`;
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
      p_workspace_name: `t11-3-smoke-${suffix}`,
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
      client_name: `t11-3-smoke-${email}`,
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
    state: "t11-3-smoke",
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

// Swift's `UUID.uuidString` returns canonical UPPERCASE form. KeychainStore's
// account format is `workspace.<UUID.uuidString>.bearer`, so seeding with the
// uppercase form makes both `retrieve` and `delete` (which compute the same
// account string) hit the seeded entry.
function upperUuid(u: string): string {
  return u.toUpperCase();
}

async function pollVaultFile(
  workspaceId: string,
  path: string,
  predicate: (row: any) => boolean,
  timeoutMs = 15000,
): Promise<any | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { data, error } = await sb
      .from("vault_files")
      .select(
        "id, path, size_bytes, plaintext_sha256, storage_object, deleted_at",
      )
      .eq("workspace_id", workspaceId)
      .eq("path", path)
      .maybeSingle();
    if (!error && data && predicate(data)) return data;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function pollKeychainGone(
  service: string,
  account: string,
  keychainPath: string,
  timeoutMs = 15000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Scope the lookup to the smoke keychain; otherwise `find-generic-password`
    // would walk the full search list and could surface stale login-keychain
    // entries from prior aborted smoke runs.
    const r = spawnSync(
      "security",
      ["find-generic-password", "-s", service, "-a", account, keychainPath],
      { stdio: "ignore" },
    );
    if (r.status !== 0) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let serverProc: ChildProcess | null = null;
let helperProc: ChildProcess | null = null;
let tmpServerVault: string | null = null;
let tmpLocalBase: string | null = null;
let tenant: Tenant | null = null;
let keychainAccount: string | null = null;
let bearer: string | null = null;
// Custom keychain isolation: seeding the login keychain via `security
// add-generic-password ... -A` looks like it should grant the helper read
// access, but on macOS 14+ cross-process `SecItemCopyMatching` with
// `kSecReturnData=true` still hangs waiting on a TCC ACL prompt that an
// LSUIElement-only app can't display. Using a dedicated, password-empty
// keychain that we add to the user search list bypasses the login-keychain
// ACL entirely — the helper resolves the entry from the smoke keychain
// without prompting.
let smokeKeychainPath: string | null = null;
let originalUserKeychainList: string[] | null = null;

function listUserKeychains(): string[] {
  const r = spawnSync("security", ["list-keychains", "-d", "user"], {
    encoding: "utf8",
  });
  if (r.status !== 0) return [];
  return (r.stdout ?? "")
    .split("\n")
    .map((line) => line.trim().replace(/^"(.*)"$/, "$1"))
    .filter((s) => s.length > 0);
}

function setUserKeychainList(paths: string[]): void {
  spawnSync("security", ["list-keychains", "-d", "user", "-s", ...paths], {
    stdio: "ignore",
  });
}

function teardownSmokeKeychain(): void {
  if (originalUserKeychainList) {
    setUserKeychainList(originalUserKeychainList);
    originalUserKeychainList = null;
  }
  if (smokeKeychainPath) {
    spawnSync("security", ["delete-keychain", smokeKeychainPath], {
      stdio: "ignore",
    });
    smokeKeychainPath = null;
  }
}

// Synchronous safety net so an unexpected exit (uncaught throw, signal)
// still restores the user search list. The async finally below is the
// primary path; this is belt-and-suspenders.
process.on("exit", teardownSmokeKeychain);

function killProcGracefully(p: ChildProcess | null): Promise<void> {
  return new Promise((resolve) => {
    if (!p || p.killed || p.exitCode !== null) return resolve();
    let done = false;
    const onExit = () => {
      if (done) return;
      done = true;
      resolve();
    };
    p.once("exit", onExit);
    p.kill("SIGTERM");
    setTimeout(() => {
      if (!done && p.exitCode === null) {
        try {
          p.kill("SIGKILL");
        } catch {}
      }
      // Resolve regardless of SIGKILL outcome to keep cleanup non-blocking.
      setTimeout(onExit, 200);
    }, 1000);
  });
}

try {
  if (!HELPER_BINARY) {
    throw new Error(
      "TAPROOT_HELPER_BINARY env not set — run via `npm run smoke:sync-push` (the .sh driver builds + sets it).",
    );
  }

  console.log("\n→ Provisioning tenant + workspace");
  tenant = await provisionTenant("A");
  check("tenant provisioned", typeof tenant.workspaceId === "string");

  console.log(`\n→ Spawning server (port ${PORT})`);
  tmpServerVault = mkdtempSync(join(tmpdir(), "taproot-smoke-server-"));
  const serverEnv: NodeJS.ProcessEnv = { ...process.env, PORT: String(PORT) };
  delete serverEnv.SYNAPSE_PASSWORD;
  serverProc = spawn(
    "npx",
    ["tsx", "src/index.ts", tmpServerVault, "--http", "--port", String(PORT)],
    { env: serverEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  const serverLogs: string[] = [];
  serverProc.stdout?.on("data", (d) => serverLogs.push(`[srv stdout] ${d}`));
  serverProc.stderr?.on("data", (d) => serverLogs.push(`[srv stderr] ${d}`));
  if (!(await waitForHealth())) {
    console.error(serverLogs.slice(-20).join(""));
    throw new Error("server boot failed");
  }
  check("server up at /health", true);

  console.log("\n→ Obtaining helper-shaped OAuth bearer");
  bearer = await obtainBearer(tenant.email);
  check("bearer issued", bearer.length > 0);

  console.log("\n→ Setting up local vault + seeding Keychain");
  tmpLocalBase = mkdtempSync(join(tmpdir(), "taproot-smoke-local-"));
  // The helper computes localFolder = <base>/Taproot/<UUID-upper>. The watcher
  // silently no-ops if the folder is missing (WorkspaceWatcher.start, see
  // lines ~63-66) — so we MUST mkdir before spawning the helper, otherwise
  // FSEvents never attaches and pushes never fire.
  const upperWS = upperUuid(tenant.workspaceId);
  const localFolder = join(tmpLocalBase, "Taproot", upperWS);
  mkdirSync(localFolder, { recursive: true });

  keychainAccount = `workspace.${upperWS}.bearer`;

  // Stand up an isolated custom keychain. Seeding the login keychain via
  // `security add-generic-password ... -A` doesn't grant cross-process read
  // access on macOS 14+: the helper's `SecItemCopyMatching(kSecReturnData)`
  // hangs on an invisible ACL prompt. A dedicated, empty-password keychain
  // added to the user search list bypasses this entirely (a standard CI
  // pattern for keychain-using macOS tests).
  smokeKeychainPath = join(tmpLocalBase, "smoke.keychain");
  let r = spawnSync(
    "security",
    ["create-keychain", "-p", "", smokeKeychainPath],
    {
      stdio: "ignore",
    },
  );
  if (r.status !== 0) throw new Error("security create-keychain failed");
  r = spawnSync("security", ["unlock-keychain", "-p", "", smokeKeychainPath], {
    stdio: "ignore",
  });
  if (r.status !== 0) throw new Error("security unlock-keychain failed");
  // Disable auto-lock so a long-running smoke can't lock itself out mid-test.
  spawnSync("security", ["set-keychain-settings", smokeKeychainPath], {
    stdio: "ignore",
  });
  originalUserKeychainList = listUserKeychains();
  setUserKeychainList([smokeKeychainPath, ...originalUserKeychainList]);
  // `-A` keeps the entry permissive within the custom keychain. Targeting
  // the keychain explicitly (last positional arg) ensures the entry lands
  // there rather than the login keychain.
  const kcAdd = spawnSync(
    "security",
    [
      "add-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      keychainAccount,
      "-w",
      bearer,
      "-A",
      smokeKeychainPath,
    ],
    { stdio: "ignore" },
  );
  if (kcAdd.status !== 0) {
    throw new Error(
      `security add-generic-password failed (exit ${kcAdd.status})`,
    );
  }
  check("isolated smoke keychain seeded with bearer", true);

  console.log("\n→ Spawning helper binary");
  const helperEnv: NodeJS.ProcessEnv = {
    ...process.env,
    TAPROOT_BASE_URL: BASE,
    TAPROOT_KEYCHAIN_SERVICE: KEYCHAIN_SERVICE,
    TAPROOT_LOCAL_FOLDER_BASE: tmpLocalBase,
  };
  helperProc = spawn(HELPER_BINARY, [], {
    env: helperEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const helperLogs: string[] = [];
  helperProc.stdout?.on("data", (d) => helperLogs.push(`[helper stdout] ${d}`));
  helperProc.stderr?.on("data", (d) => helperLogs.push(`[helper stderr] ${d}`));
  // Give the helper a moment to load Keychain + start FSEvents. The pickup
  // doc and plan §7 step 7 call this out as the boot budget.
  await new Promise((r) => setTimeout(r, 1500));
  if (helperProc.exitCode !== null) {
    console.error(helperLogs.slice(-20).join(""));
    throw new Error(`helper exited prematurely (code=${helperProc.exitCode})`);
  }
  check("helper running", true);

  console.log("\n→ Test 1: upsert via local file write");
  const filePath = join(localFolder, "smoke.md");
  const content = "# T11.3 smoke\n";
  const expectedSha = createHash("sha256")
    .update(content, "utf8")
    .digest("hex");
  const expectedSize = Buffer.byteLength(content, "utf8");
  writeFileSync(filePath, content);

  const upserted = await pollVaultFile(
    tenant.workspaceId,
    "smoke.md",
    (row) => row.deleted_at == null && typeof row.id === "string",
  );
  check("vault_files row created for smoke.md", upserted !== null, upserted);

  if (upserted) {
    // plaintext_sha256 returns from PostgREST as `\x<hex>` (or, depending on
    // server config, base64). Normalize to compare hex.
    const shaRaw: string = String(upserted.plaintext_sha256 ?? "");
    const shaHex = shaRaw.startsWith("\\x")
      ? shaRaw.slice(2).toLowerCase()
      : Buffer.from(shaRaw, "base64").toString("hex").toLowerCase();
    check("plaintext_sha256 matches expected", shaHex === expectedSha, {
      got: shaHex,
      want: expectedSha,
    });
    check(
      "size_bytes matches expected utf8 length",
      upserted.size_bytes === expectedSize,
      { got: upserted.size_bytes, want: expectedSize },
    );

    // Storage download poll: vault_files INSERT happens before storage.upload
    // completes server-side, and Supabase Storage's read-after-write
    // consistency can lag a few hundred ms even after the writeFile call
    // returns 200. Poll for up to 5s before giving up.
    let blob: Blob | null = null;
    let dlErr: { message: string } | null = null;
    const dlStart = Date.now();
    while (Date.now() - dlStart < 5000) {
      const r = await sb.storage
        .from(VAULT_BLOBS_BUCKET)
        .download(upserted.storage_object);
      if (!r.error && r.data) {
        blob = r.data;
        dlErr = null;
        break;
      }
      dlErr = r.error ?? { message: "no body" };
      await new Promise((r) => setTimeout(r, 250));
    }
    check("Storage blob exists at storage_object", blob !== null, {
      dlErr: dlErr?.message,
      storage_object: upserted.storage_object,
    });
  }

  console.log("\n→ Test 2: delete via local fs.unlink");
  unlinkSync(filePath);
  const deleted = await pollVaultFile(
    tenant.workspaceId,
    "smoke.md",
    (row) => row.deleted_at != null,
  );
  check(
    "vault_files row marked deleted",
    deleted !== null,
    deleted ? { deleted_at: deleted.deleted_at } : null,
  );

  console.log("\n→ Test 3: 401 → helper signs out (Keychain entry gone)");
  // Revoke the OAuth token in Postgres. Token is sha256-hashed at rest as a
  // `\x<hex>` bytea. Match oauth.ts:tokenHashByteaParam exactly.
  const tokenHashHex = createHash("sha256").update(bearer).digest("hex");
  const { error: revokeErr, count: revokedCount } = await sb
    .from("oauth_tokens")
    .update({ revoked_at: new Date().toISOString() }, { count: "exact" })
    .eq("token_hash", `\\x${tokenHashHex}`);
  check("oauth_tokens revoked", !revokeErr && (revokedCount ?? 0) === 1, {
    error: revokeErr?.message,
    count: revokedCount,
  });

  // Trigger a new push that will receive 401 and fire onUnauthorized.
  writeFileSync(join(localFolder, "after-revoke.md"), "# triggers 401\n");

  if (smokeKeychainPath) {
    const gone = await pollKeychainGone(
      KEYCHAIN_SERVICE,
      keychainAccount,
      smokeKeychainPath,
    );
    check("Keychain entry removed by helper sign-out", gone);
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    console.log("\n--- helper logs (tail) ---");
    console.log(helperLogs.slice(-30).join(""));
    console.log("--- server logs (tail) ---");
    console.log(serverLogs.slice(-30).join(""));
  }
} catch (err: any) {
  console.error(`\nFATAL: ${err?.stack ?? err?.message ?? err}`);
  fail++;
} finally {
  console.log("\nCleanup:");
  await killProcGracefully(helperProc);
  await killProcGracefully(serverProc);
  if (tenant) {
    try {
      await nukeWorkspace(sb, tenant.workspaceId, tenant.userId);
    } catch (e: any) {
      console.error(`  nukeWorkspace failed: ${e?.message ?? e}`);
    }
    await sb.from("workspaces").delete().eq("id", tenant.workspaceId);
    await sb.auth.admin.deleteUser(tenant.userId);
    console.log(`  cleaned up tenant ${tenant.workspaceId}`);
  }
  // Restore the user keychain search list and delete the smoke keychain.
  // Idempotent; the `process.on('exit')` handler retries this synchronously
  // if the async finally is interrupted.
  teardownSmokeKeychain();
  if (tmpLocalBase) rmSync(tmpLocalBase, { recursive: true, force: true });
  if (tmpServerVault) rmSync(tmpServerVault, { recursive: true, force: true });
}

if (fail > 0) process.exit(1);
