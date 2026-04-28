/**
 * Stage 1 T4.5 — mutating metadata methods smoke.
 *   delete (soft) / move / mkdir (no-op)
 *
 * Asserts:
 *   - delete: exists→false, vault_files row present with deleted_at set,
 *     blob still in Storage (T4.6 nuke is what reclaims storage)
 *   - delete missing → NotFoundError
 *   - delete is idempotent under "second delete returns NotFoundError"
 *     (no live row to soft-delete after the first call)
 *   - delete then write same path → new row inserted (partial unique
 *     index excludes deleted rows)
 *   - move: target exists, source gone, file_id stable, storage_object
 *     stable, blob byte-identical (rename doesn't re-upload)
 *   - move missing → NotFoundError
 *   - move to existing live path → ConflictError (typed)
 *   - move(same → same) is no-op
 *   - mkdir is a no-op (returns without error)
 */
import { createClient } from "@supabase/supabase-js";
import { generateDek, wrapDek } from "../src/api/crypto.js";
import { SupabaseEncryptedMirrorBackend } from "../src/utils/supabase-mirror.js";
import { ConflictError, NotFoundError } from "../src/utils/storage.js";

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

const testEmail = `t4-5-${Date.now()}@taproot-test.local`;
let userId: string | null = null;
let workspaceId: string | null = null;
const writtenObjects = new Set<string>();

async function trackObject(path: string) {
  const { data: row } = await sb
    .from("vault_files")
    .select("storage_object")
    .eq("workspace_id", workspaceId!)
    .eq("path", path)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (row?.storage_object) writtenObjects.add(row.storage_object as string);
}

try {
  console.log(`\n→ Provisioning test user (${testEmail})`);
  const { data: userData } = await sb.auth.admin.createUser({
    email: testEmail,
    password: "t4-5-pw-12345",
    email_confirm: true,
  });
  userId = userData!.user!.id;

  const wrapped = wrapDek(generateDek());
  const wrappedParam = `\\x${wrapped.toString("hex")}`;
  const { data: wsData } = await sb.rpc("create_workspace_for_new_user", {
    p_user_id: userId,
    p_workspace_name: "t4-5-smoke",
    p_wrapped_dek: wrappedParam,
  });
  workspaceId = wsData as string;

  const backend =
    await SupabaseEncryptedMirrorBackend.forWorkspace(workspaceId);

  console.log("\n→ delete (soft)");

  await backend.writeFile("foo.md", "to be deleted");
  await trackObject("foo.md");
  const { data: preDelRow } = await sb
    .from("vault_files")
    .select("id, storage_object, deleted_at")
    .eq("workspace_id", workspaceId)
    .eq("path", "foo.md")
    .single();
  const fooId = preDelRow!.id;
  const fooStorage = preDelRow!.storage_object as string;
  check("pre-delete: deleted_at is null", preDelRow?.deleted_at === null);

  await backend.delete("foo.md");
  check("delete returns without error", true);
  check(
    "post-delete: exists('foo.md') = false",
    (await backend.exists("foo.md")) === false,
  );

  const { data: postDelRow } = await sb
    .from("vault_files")
    .select("deleted_at, storage_object")
    .eq("id", fooId)
    .single();
  check(
    "post-delete: row still in DB with deleted_at set",
    postDelRow?.deleted_at !== null,
  );
  check(
    "post-delete: storage_object stays the same (blob not removed)",
    postDelRow?.storage_object === fooStorage,
  );

  // Storage blob still present
  const { data: blob } = await sb.storage
    .from("vault-blobs")
    .download(fooStorage);
  check(
    "post-delete: storage blob still present (T4.6 nuke is what reclaims)",
    !!blob,
  );

  // Second delete on same path → NotFoundError (no live row)
  let secondDelErr: unknown = null;
  try {
    await backend.delete("foo.md");
  } catch (e) {
    secondDelErr = e;
  }
  check(
    "second delete on already-deleted path → NotFoundError",
    secondDelErr instanceof NotFoundError,
    secondDelErr,
  );

  let missingDelErr: unknown = null;
  try {
    await backend.delete("never-existed.md");
  } catch (e) {
    missingDelErr = e;
  }
  check(
    "delete(never-existed) → NotFoundError",
    missingDelErr instanceof NotFoundError,
    missingDelErr,
  );

  // Re-write same path: should INSERT new row (partial unique excludes the
  // soft-deleted row at this path)
  await backend.writeFile("foo.md", "fresh start");
  await trackObject("foo.md");
  const { data: rewriteRows } = await sb
    .from("vault_files")
    .select("id, deleted_at")
    .eq("workspace_id", workspaceId)
    .eq("path", "foo.md")
    .order("created_at", { ascending: true });
  check(
    "after delete+write: 2 rows at path (1 deleted, 1 live)",
    rewriteRows?.length === 2 &&
      rewriteRows[0].deleted_at !== null &&
      rewriteRows[1].deleted_at === null,
    rewriteRows,
  );
  check(
    "after delete+write: live row has a NEW id (not the deleted one)",
    rewriteRows?.[1].id !== fooId,
  );
  const liveExists = await backend.exists("foo.md");
  check("after delete+write: exists('foo.md') = true", liveExists === true);

  console.log("\n→ move (rename)");

  await backend.writeFile("rename-src.md", "stable bytes");
  await trackObject("rename-src.md");
  const { data: srcRow } = await sb
    .from("vault_files")
    .select("id, storage_object")
    .eq("workspace_id", workspaceId)
    .eq("path", "rename-src.md")
    .single();
  const srcId = srcRow!.id;
  const srcStorage = srcRow!.storage_object as string;

  // Snapshot the blob bytes before the move
  const { data: blobBefore } = await sb.storage
    .from("vault-blobs")
    .download(srcStorage);
  const bytesBefore = Buffer.from(await blobBefore!.arrayBuffer());

  await backend.move("rename-src.md", "subdir/rename-dst.md");
  check("move returns without error", true);
  check(
    "post-move: exists('rename-src.md') = false",
    (await backend.exists("rename-src.md")) === false,
  );
  check(
    "post-move: exists('subdir/rename-dst.md') = true",
    (await backend.exists("subdir/rename-dst.md")) === true,
  );

  const { data: dstRow } = await sb
    .from("vault_files")
    .select("id, storage_object")
    .eq("workspace_id", workspaceId)
    .eq("path", "subdir/rename-dst.md")
    .is("deleted_at", null)
    .single();
  check("post-move: file_id stable", dstRow?.id === srcId);
  check(
    "post-move: storage_object stable (blob NOT re-uploaded)",
    dstRow?.storage_object === srcStorage,
  );

  const { data: blobAfter } = await sb.storage
    .from("vault-blobs")
    .download(srcStorage);
  const bytesAfter = Buffer.from(await blobAfter!.arrayBuffer());
  check("post-move: blob bytes byte-identical", bytesBefore.equals(bytesAfter));

  // Round-trip the renamed file
  const renamedContent = await backend.readFile("subdir/rename-dst.md");
  check(
    "post-move: readFile decrypts correctly",
    renamedContent === "stable bytes",
  );

  // move missing → NotFoundError
  let missingMoveErr: unknown = null;
  try {
    await backend.move("never-existed.md", "elsewhere.md");
  } catch (e) {
    missingMoveErr = e;
  }
  check(
    "move(missing → ...) → NotFoundError",
    missingMoveErr instanceof NotFoundError,
    missingMoveErr,
  );

  // move to existing path → ConflictError
  await backend.writeFile("a.md", "alpha");
  await trackObject("a.md");
  await backend.writeFile("b.md", "beta");
  await trackObject("b.md");
  let conflictErr: unknown = null;
  try {
    await backend.move("a.md", "b.md");
  } catch (e) {
    conflictErr = e;
  }
  check(
    "move to live target → ConflictError (typed)",
    conflictErr instanceof ConflictError,
    conflictErr,
  );
  check(
    "after conflict: source 'a.md' still live, untouched",
    (await backend.exists("a.md")) === true,
  );

  // move(same → same) is a no-op
  await backend.move("a.md", "a.md");
  check("move(same → same) is no-op (no error)", true);
  check(
    "after self-move: 'a.md' still live",
    (await backend.exists("a.md")) === true,
  );

  console.log("\n→ mkdir (no-op)");
  await backend.mkdir("any/path/here");
  check("mkdir returns without error", true);
  // No vault_files row should be created
  const { count: dirCount } = await sb
    .from("vault_files")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("path", "any/path/here");
  check("mkdir does not insert a vault_files row", (dirCount ?? 0) === 0);

  console.log(`\n${pass} pass, ${fail} fail`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
} finally {
  console.log("\nCleanup:");
  if (writtenObjects.size > 0) {
    const r = await sb.storage.from("vault-blobs").remove([...writtenObjects]);
    console.log(
      `  storage objects delete (${writtenObjects.size}): ${r.error ? r.error.message : "ok"}`,
    );
  }
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
