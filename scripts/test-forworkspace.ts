/**
 * Stage 1 T4.1 — `SupabaseEncryptedMirrorBackend.forWorkspace` smoke.
 *
 * Provisions a test user via Supabase Auth admin API, runs the atomic signup
 * RPC to mint a workspace + wrapped DEK, calls forWorkspace, asserts:
 *   - factory returns an instance (no throw on happy path)
 *   - audit_log has a `kek_unwrap` row for the workspace
 *   - missing-workspace lookup throws NotFoundError (typed)
 *
 * Cleans up the test user, workspace, and audit rows on exit (best-effort).
 *
 * Run: tsx scripts/test-forworkspace.ts
 *   Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TAPROOT_KEK in env.
 */
import { createClient } from "@supabase/supabase-js";
import { generateDek, wrapDek } from "../src/api/crypto.js";
import { SupabaseEncryptedMirrorBackend } from "../src/utils/supabase-mirror.js";
import { NotFoundError } from "../src/utils/storage.js";

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

const testEmail = `t4-1-${Date.now()}@taproot-test.local`;
let userId: string | null = null;
let workspaceId: string | null = null;

try {
  console.log(`\n→ Provisioning test user (${testEmail})`);

  const { data: userData, error: userErr } = await sb.auth.admin.createUser({
    email: testEmail,
    password: "t4-1-pw-12345",
    email_confirm: true,
  });
  if (userErr || !userData.user) throw userErr ?? new Error("no user data");
  userId = userData.user.id;
  check("admin.createUser succeeds", true);

  const wrapped = wrapDek(generateDek());
  // PostgREST/Postgres bytea literal format: \x followed by hex.
  // (Passing the raw Buffer would be JSON-stringified by supabase-js into
  // `{"type":"Buffer","data":[...]}` and stored as bytes of that JSON string.)
  const wrappedParam = `\\x${wrapped.toString("hex")}`;
  const { data: wsData, error: wsErr } = await sb.rpc(
    "create_workspace_for_new_user",
    {
      p_user_id: userId,
      p_workspace_name: "t4-1-smoke",
      p_wrapped_dek: wrappedParam,
    },
  );
  if (wsErr) throw wsErr;
  workspaceId = wsData as string;
  check(
    "atomic signup RPC returns workspace_id",
    typeof workspaceId === "string",
  );

  console.log("\n→ forWorkspace happy path");

  const auditBefore = await sb
    .from("audit_log")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("operation", "kek_unwrap");
  const beforeCount = auditBefore.count ?? 0;

  const backend =
    await SupabaseEncryptedMirrorBackend.forWorkspace(workspaceId);
  check(
    "forWorkspace returns SupabaseEncryptedMirrorBackend instance",
    backend instanceof SupabaseEncryptedMirrorBackend,
  );
  // The audit_log assertions below already prove the unwrap actually ran
  // (otherwise no kek_unwrap row would have been written). Per-sub-task
  // smokes don't depend on later sub-tasks' NotImplemented messages —
  // those flip from "throws" to "works" as the rest of T4 lands.

  const auditAfter = await sb
    .from("audit_log")
    .select("id, details", { count: "exact" })
    .eq("workspace_id", workspaceId)
    .eq("operation", "kek_unwrap")
    .order("created_at", { ascending: false });
  const afterCount = auditAfter.count ?? 0;
  check(
    "audit_log gained exactly one kek_unwrap row",
    afterCount === beforeCount + 1,
    { before: beforeCount, after: afterCount },
  );

  const latestRow = auditAfter.data?.[0];
  check(
    "audit row details.reason = 'backend_construct'",
    latestRow?.details?.reason === "backend_construct",
    latestRow?.details,
  );

  console.log("\n→ forWorkspace error paths");

  // Fake UUID — workspace doesn't exist
  const fakeWsId = "00000000-0000-0000-0000-000000000000";
  let unknownErr: unknown = null;
  try {
    await SupabaseEncryptedMirrorBackend.forWorkspace(fakeWsId);
  } catch (e) {
    unknownErr = e;
  }
  check(
    "forWorkspace(unknown) throws NotFoundError (typed)",
    unknownErr instanceof NotFoundError,
    unknownErr instanceof Error ? unknownErr.message : unknownErr,
  );
  if (unknownErr instanceof Error) {
    check(
      "NotFoundError message names tenant_keys",
      unknownErr.message.includes("tenant_keys"),
      unknownErr.message,
    );
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
} finally {
  console.log("\nCleanup:");
  if (workspaceId) {
    const r = await sb.from("workspaces").delete().eq("id", workspaceId);
    console.log(`  workspaces delete: ${r.error ? r.error.message : "ok"}`);
  }
  if (userId) {
    const r = await sb.auth.admin.deleteUser(userId);
    console.log(`  user delete: ${r.error ? r.error.message : "ok"}`);
  }
}

if (fail > 0) process.exit(1);
