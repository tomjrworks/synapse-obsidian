/**
 * Stage 1 T4.6 — `nukeWorkspace` smoke ("Leave Taproot" end-to-end).
 *
 * Calls `nukeWorkspace()` directly (not via HTTP). Asserts that after a
 * nuke:
 *   - vault_files rows for this workspace = 0
 *   - tenant_keys row for this workspace = 0
 *   - Supabase Storage objects under {workspace_id}/ = 0
 *   - audit_log has exactly one vault_nuke row with object_count
 *   - workspaces row + workspace_members row both survive (account stays)
 *   - forWorkspace(workspaceId) now throws NotFoundError (no DEK to unwrap)
 *   - nuke is idempotent: second call returns counts of 0, doesn't throw
 *
 * Cleans up workspace + user on exit.
 */
import { createClient } from "@supabase/supabase-js";
import { generateDek, wrapDek } from "../src/api/crypto.js";
import {
  SupabaseEncryptedMirrorBackend,
  nukeWorkspace,
} from "../src/utils/supabase-mirror.js";
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

const testEmail = `t4-6-${Date.now()}@taproot-test.local`;
let userId: string | null = null;
let workspaceId: string | null = null;

try {
  console.log(`\n→ Provisioning test user (${testEmail})`);
  const { data: userData } = await sb.auth.admin.createUser({
    email: testEmail,
    password: "t4-6-pw-12345",
    email_confirm: true,
  });
  userId = userData!.user!.id;

  const wrapped = wrapDek(generateDek());
  const wrappedParam = `\\x${wrapped.toString("hex")}`;
  const { data: wsData } = await sb.rpc("create_workspace_for_new_user", {
    p_user_id: userId,
    p_workspace_name: "t4-6-smoke",
    p_wrapped_dek: wrappedParam,
  });
  workspaceId = wsData as string;

  const backend =
    await SupabaseEncryptedMirrorBackend.forWorkspace(workspaceId);

  console.log("\n→ Seeding files (3 paths, ~few KB total)");
  await backend.writeFile("foo.md", "alpha");
  await backend.writeFile("subdir/bar.md", "beta beta");
  await backend.writeFile("nested/deep/baz.md", "x".repeat(2048));

  // Pre-nuke fixture sanity
  const { count: preFiles } = await sb
    .from("vault_files")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);
  check("pre-nuke: 3 vault_files rows present", preFiles === 3, preFiles);

  const { count: preKeys } = await sb
    .from("tenant_keys")
    .select("workspace_id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);
  check("pre-nuke: tenant_keys row present", preKeys === 1, preKeys);

  const { data: preList } = await sb.storage
    .from("vault-blobs")
    .list(workspaceId, { limit: 100 });
  check(
    "pre-nuke: 3 storage objects present under workspace folder",
    (preList?.length ?? 0) === 3,
    preList?.map((o) => o.name),
  );

  console.log("\n→ nukeWorkspace");
  const result = await nukeWorkspace(sb, workspaceId, userId);
  check("nuke returns objectCount = 3", result.objectCount === 3, result);
  check("nuke returns fileRowCount = 3", result.fileRowCount === 3, result);

  console.log("\n→ Post-nuke state");
  const { count: postFiles } = await sb
    .from("vault_files")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);
  check("post-nuke: vault_files = 0", (postFiles ?? 0) === 0, postFiles);

  const { count: postKeys } = await sb
    .from("tenant_keys")
    .select("workspace_id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);
  check("post-nuke: tenant_keys = 0", (postKeys ?? 0) === 0, postKeys);

  const { data: postList } = await sb.storage
    .from("vault-blobs")
    .list(workspaceId, { limit: 100 });
  check(
    "post-nuke: 0 storage objects under workspace folder",
    (postList?.length ?? 0) === 0,
    postList?.map((o) => o.name),
  );

  // Account survives
  const { count: postWs } = await sb
    .from("workspaces")
    .select("id", { count: "exact", head: true })
    .eq("id", workspaceId);
  check("post-nuke: workspaces row survives", postWs === 1, postWs);

  const { count: postMembers } = await sb
    .from("workspace_members")
    .select("user_id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);
  check(
    "post-nuke: workspace_members row(s) survive",
    (postMembers ?? 0) >= 1,
    postMembers,
  );

  // Audit row
  const { data: auditRows, count: auditCount } = await sb
    .from("audit_log")
    .select("operation, details, user_id", { count: "exact" })
    .eq("workspace_id", workspaceId)
    .eq("operation", "vault_nuke");
  check(
    "post-nuke: exactly one vault_nuke audit row",
    auditCount === 1,
    auditCount,
  );
  check(
    "post-nuke: vault_nuke audit row.details.object_count = 3",
    auditRows?.[0]?.details?.object_count === 3,
    auditRows?.[0]?.details,
  );
  check(
    "post-nuke: vault_nuke audit row.user_id = actor",
    auditRows?.[0]?.user_id === userId,
    auditRows?.[0]?.user_id,
  );

  // forWorkspace post-nuke → NotFoundError (no DEK)
  let postFwErr: unknown = null;
  try {
    await SupabaseEncryptedMirrorBackend.forWorkspace(workspaceId);
  } catch (e) {
    postFwErr = e;
  }
  check(
    "post-nuke: forWorkspace throws NotFoundError (no DEK to unwrap)",
    postFwErr instanceof NotFoundError,
    postFwErr,
  );

  // Idempotency
  console.log("\n→ Second nuke (idempotency)");
  const second = await nukeWorkspace(sb, workspaceId, userId);
  check(
    "second nuke returns objectCount = 0",
    second.objectCount === 0,
    second,
  );
  check(
    "second nuke returns fileRowCount = 0",
    second.fileRowCount === 0,
    second,
  );

  const { count: auditCount2 } = await sb
    .from("audit_log")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("operation", "vault_nuke");
  check(
    "second nuke writes a new vault_nuke audit row (count = 2)",
    auditCount2 === 2,
    auditCount2,
  );

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
