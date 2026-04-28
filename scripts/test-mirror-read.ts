/**
 * Stage 1 T4.3 — `SupabaseEncryptedMirrorBackend.readFile` smoke.
 *
 * Asserts:
 *   - write→read round-trip equals original (utf-8, emoji, multi-KB)
 *   - missing path → NotFoundError (typed)
 *   - corrupted ciphertext byte → throws (auth tag rejection, NOT silent)
 *   - corrupted Storage object missing while row remains → NotFoundError
 *     (graceful, not a crypto error)
 *
 * Cleans up storage objects + workspace + user on exit.
 *
 * Run: tsx scripts/test-mirror-read.ts
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

const testEmail = `t4-3-${Date.now()}@taproot-test.local`;
let userId: string | null = null;
let workspaceId: string | null = null;
const writtenObjects: string[] = [];

try {
  console.log(`\n→ Provisioning test user (${testEmail})`);

  const { data: userData } = await sb.auth.admin.createUser({
    email: testEmail,
    password: "t4-3-pw-12345",
    email_confirm: true,
  });
  userId = userData!.user!.id;

  const wrapped = wrapDek(generateDek());
  const wrappedParam = `\\x${wrapped.toString("hex")}`;
  const { data: wsData } = await sb.rpc("create_workspace_for_new_user", {
    p_user_id: userId,
    p_workspace_name: "t4-3-smoke",
    p_wrapped_dek: wrappedParam,
  });
  workspaceId = wsData as string;

  const backend =
    await SupabaseEncryptedMirrorBackend.forWorkspace(workspaceId);

  console.log("\n→ write → read round-trip");

  const cases: Array<[string, string]> = [
    ["foo.md", "hello world"],
    ["subdir/with-emoji.md", "🌱 Taproot — your AI brain.\n\n## heading\n"],
    ["nested/deep/path.md", "x".repeat(8 * 1024)], // 8 KiB
  ];

  for (const [path, content] of cases) {
    await backend.writeFile(path, content);
    const got = await backend.readFile(path);
    check(`round-trip ${path} (${content.length} chars)`, got === content);

    // Track storage object for cleanup
    const { data: row } = await sb
      .from("vault_files")
      .select("storage_object")
      .eq("workspace_id", workspaceId)
      .eq("path", path)
      .single();
    if (row?.storage_object) writtenObjects.push(row.storage_object);
  }

  console.log("\n→ readFile error paths");

  // Missing path → NotFoundError
  let missingErr: unknown = null;
  try {
    await backend.readFile("does-not-exist.md");
  } catch (e) {
    missingErr = e;
  }
  check(
    "readFile(missing) throws NotFoundError (typed)",
    missingErr instanceof NotFoundError,
    missingErr instanceof Error ? missingErr.message : missingErr,
  );

  // Whitespace path → generic Error (rejected before lookup)
  let emptyErr: unknown = null;
  try {
    await backend.readFile("   ");
  } catch (e) {
    emptyErr = e;
  }
  check("readFile rejects whitespace-only path", emptyErr instanceof Error);

  // Corrupt ciphertext via service role: flip one byte in the stored blob
  const corruptPath = "to-be-corrupted.md";
  await backend.writeFile(corruptPath, "I will be corrupted");
  const { data: corruptRow } = await sb
    .from("vault_files")
    .select("storage_object")
    .eq("workspace_id", workspaceId)
    .eq("path", corruptPath)
    .single();
  const corruptKey = corruptRow!.storage_object as string;
  writtenObjects.push(corruptKey);

  const { data: origBlob } = await sb.storage
    .from("vault-blobs")
    .download(corruptKey);
  const orig = Buffer.from(await origBlob!.arrayBuffer());
  const tampered = Buffer.from(orig);
  tampered[tampered.length - 1] ^= 0x01;
  await sb.storage.from("vault-blobs").upload(corruptKey, tampered, {
    upsert: true,
    contentType: "application/octet-stream",
  });

  let corruptErr: unknown = null;
  try {
    await backend.readFile(corruptPath);
  } catch (e) {
    corruptErr = e;
  }
  check(
    "readFile of corrupted ciphertext throws (auth tag rejection, NOT silent decode)",
    corruptErr instanceof Error,
    corruptErr,
  );
  check(
    "corrupt-ciphertext error is NOT NotFoundError (it's a crypto error)",
    !(corruptErr instanceof NotFoundError),
    corruptErr instanceof Error ? corruptErr.message : corruptErr,
  );

  // Missing storage object while row exists: delete the blob, leave the row
  const danglingPath = "dangling.md";
  await backend.writeFile(danglingPath, "blob will go missing");
  const { data: danglingRow } = await sb
    .from("vault_files")
    .select("storage_object")
    .eq("workspace_id", workspaceId)
    .eq("path", danglingPath)
    .single();
  await sb.storage
    .from("vault-blobs")
    .remove([danglingRow!.storage_object as string]);

  let danglingErr: unknown = null;
  try {
    await backend.readFile(danglingPath);
  } catch (e) {
    danglingErr = e;
  }
  check(
    "readFile when blob is missing → NotFoundError (graceful, not a crypto error)",
    danglingErr instanceof NotFoundError,
    danglingErr instanceof Error ? danglingErr.message : danglingErr,
  );

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
