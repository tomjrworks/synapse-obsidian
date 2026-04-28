/**
 * Stage 1 T4.2 — `SupabaseEncryptedMirrorBackend.writeFile` smoke.
 *
 * Provisions a test user + workspace, calls writeFile, asserts:
 *   - vault_files row exists with correct path, plaintext size, sha256, mime
 *   - storage_object key follows `{workspace_id}/{file_id}` shape
 *   - Storage object exists at that key (length matches ciphertext envelope)
 *   - Ciphertext bytes round-trip through decryptBlob to original plaintext
 *   - Second writeFile to same path UPDATEs (single live row, sha256 changes,
 *     storage_object stays the same — proves we reuse file_id)
 *   - writeFile rejects empty path
 *
 * Cleans up storage objects + workspace + user on exit.
 *
 * Run: tsx scripts/test-mirror-write.ts
 *   Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TAPROOT_KEK in env.
 */
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import {
  generateDek,
  wrapDek,
  decryptBlob,
  unwrapDek,
} from "../src/api/crypto.js";
import { SupabaseEncryptedMirrorBackend } from "../src/utils/supabase-mirror.js";

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

const testEmail = `t4-2-${Date.now()}@taproot-test.local`;
let userId: string | null = null;
let workspaceId: string | null = null;
const writtenObjects: string[] = [];

try {
  console.log(`\n→ Provisioning test user (${testEmail})`);

  const { data: userData, error: userErr } = await sb.auth.admin.createUser({
    email: testEmail,
    password: "t4-2-pw-12345",
    email_confirm: true,
  });
  if (userErr || !userData.user) throw userErr ?? new Error("no user data");
  userId = userData.user.id;

  const wrapped = wrapDek(generateDek());
  const wrappedParam = `\\x${wrapped.toString("hex")}`;
  const { data: wsData, error: wsErr } = await sb.rpc(
    "create_workspace_for_new_user",
    {
      p_user_id: userId,
      p_workspace_name: "t4-2-smoke",
      p_wrapped_dek: wrappedParam,
    },
  );
  if (wsErr) throw wsErr;
  workspaceId = wsData as string;

  const backend =
    await SupabaseEncryptedMirrorBackend.forWorkspace(workspaceId);

  console.log("\n→ writeFile happy path (new file)");

  const path1 = "foo.md";
  const content1 = "hello world";
  await backend.writeFile(path1, content1);

  const { data: row1 } = await sb
    .from("vault_files")
    .select(
      "id, path, size_bytes, plaintext_sha256, mime_type, storage_object, deleted_at",
    )
    .eq("workspace_id", workspaceId)
    .eq("path", path1)
    .single();

  check("vault_files row exists for foo.md", !!row1);
  check("path matches", row1?.path === path1);
  check(
    "size_bytes = plaintext byte length (11)",
    row1?.size_bytes === 11,
    row1?.size_bytes,
  );
  check("mime_type = text/markdown", row1?.mime_type === "text/markdown");
  check("deleted_at is null", row1?.deleted_at === null);
  check(
    "storage_object follows {workspace_id}/{file_id} shape",
    row1?.storage_object === `${workspaceId}/${row1?.id}`,
    row1?.storage_object,
  );

  // sha256 round-trip via bytea \x...
  const expectedSha = createHash("sha256")
    .update(content1, "utf8")
    .digest("hex");
  const storedSha = (row1?.plaintext_sha256 as string).startsWith("\\x")
    ? (row1?.plaintext_sha256 as string).slice(2)
    : Buffer.from(row1?.plaintext_sha256 as string, "base64").toString("hex");
  check("plaintext_sha256 matches sha256(content)", storedSha === expectedSha);

  // Storage object exists and round-trips through DEK
  if (row1?.storage_object) writtenObjects.push(row1.storage_object);
  const { data: blob1, error: dl1Err } = await sb.storage
    .from("vault-blobs")
    .download(row1!.storage_object);
  check("storage object downloadable", !dl1Err && !!blob1, dl1Err?.message);

  if (blob1) {
    const ciphertext1 = Buffer.from(await blob1.arrayBuffer());
    check(
      "ciphertext envelope size = plaintext + 28 (12-IV + 16-tag)",
      ciphertext1.length === 11 + 28,
      ciphertext1.length,
    );

    // Re-derive the DEK to verify round-trip (mirrors what readFile will do in T4.3).
    const { data: keyRow } = await sb
      .from("tenant_keys")
      .select("wrapped_dek")
      .eq("workspace_id", workspaceId)
      .single();
    const wrappedHex = (keyRow?.wrapped_dek as string).slice(2);
    const dek = unwrapDek(Buffer.from(wrappedHex, "hex"));
    const decrypted = decryptBlob(ciphertext1, dek).toString("utf8");
    check(
      "ciphertext decrypts back to original plaintext",
      decrypted === content1,
    );
  }

  console.log("\n→ writeFile UPDATE path (same path, new content)");

  const content2 = "completely different content with more bytes than before";
  await backend.writeFile(path1, content2);

  const { data: row2 } = await sb
    .from("vault_files")
    .select("id, size_bytes, plaintext_sha256, storage_object")
    .eq("workspace_id", workspaceId)
    .eq("path", path1)
    .is("deleted_at", null)
    .single();

  check("still exactly one live row at foo.md", !!row2);
  check("file_id stable across writes (same id)", row2?.id === row1?.id);
  check(
    "storage_object stable across writes",
    row2?.storage_object === row1?.storage_object,
  );
  check(
    "size_bytes updated to new plaintext length",
    row2?.size_bytes === Buffer.byteLength(content2, "utf8"),
    { got: row2?.size_bytes, expected: Buffer.byteLength(content2, "utf8") },
  );

  const expectedSha2 = createHash("sha256")
    .update(content2, "utf8")
    .digest("hex");
  const storedSha2 = (row2?.plaintext_sha256 as string).slice(2);
  check("plaintext_sha256 reflects new content", storedSha2 === expectedSha2);

  // Total live rows for this workspace at path1 should still be 1
  const { count: liveCount } = await sb
    .from("vault_files")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("path", path1)
    .is("deleted_at", null);
  check(
    "partial unique constraint still satisfied (1 live row)",
    liveCount === 1,
  );

  console.log(
    "\n→ writeFile second new file (separate path → separate row + object)",
  );

  const path2 = "subdir/bar.md";
  await backend.writeFile(path2, "contents of bar");

  const { data: row3 } = await sb
    .from("vault_files")
    .select("id, path, storage_object")
    .eq("workspace_id", workspaceId)
    .eq("path", path2)
    .single();

  check("second path got a distinct row", !!row3 && row3.id !== row1?.id);
  check(
    "second path has its own storage_object",
    row3?.storage_object && row3.storage_object !== row1?.storage_object,
    row3?.storage_object,
  );
  if (row3?.storage_object) writtenObjects.push(row3.storage_object);

  console.log("\n→ writeFile error path (empty path)");

  let emptyErr: unknown = null;
  try {
    await backend.writeFile("   ", "anything");
  } catch (e) {
    emptyErr = e;
  }
  check("writeFile rejects whitespace-only path", emptyErr instanceof Error);

  console.log(`\n${pass} pass, ${fail} fail`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
} finally {
  console.log("\nCleanup:");
  if (writtenObjects.length > 0) {
    const r = await sb.storage.from("vault-blobs").remove(writtenObjects);
    console.log(
      `  storage objects delete (${writtenObjects.length}): ${r.error ? r.error.message : "ok"}`,
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
