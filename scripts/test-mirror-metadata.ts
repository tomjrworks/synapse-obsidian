/**
 * Stage 1 T4.4 — read-only metadata methods smoke.
 *   listFiles / exists / stat / recentFiles
 *
 * Asserts:
 *   - listFiles() returns all live paths
 *   - listFiles(subPath) restricts to prefix
 *   - listFiles(subPath, recursive=false) returns only direct children
 *   - listFiles(undefined, recursive=false) returns only top-level paths
 *   - listFiles(unknownPrefix) returns []
 *   - exists(present) true; exists(missing) false; exists("   ") false (no throw)
 *   - stat returns plaintext size + mtime within 5s of write
 *   - stat(missing) throws NotFoundError
 *   - recentFiles ordered by modified_at desc; n=0 → []; n>total → all
 *
 * Cleans up storage objects + workspace + user on exit.
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

const testEmail = `t4-4-${Date.now()}@taproot-test.local`;
let userId: string | null = null;
let workspaceId: string | null = null;
const writtenObjects: string[] = [];

async function trackObject(path: string) {
  const { data: row } = await sb
    .from("vault_files")
    .select("storage_object")
    .eq("workspace_id", workspaceId!)
    .eq("path", path)
    .single();
  if (row?.storage_object) writtenObjects.push(row.storage_object as string);
}

try {
  console.log(`\n→ Provisioning test user (${testEmail})`);
  const { data: userData } = await sb.auth.admin.createUser({
    email: testEmail,
    password: "t4-4-pw-12345",
    email_confirm: true,
  });
  userId = userData!.user!.id;

  const wrapped = wrapDek(generateDek());
  const wrappedParam = `\\x${wrapped.toString("hex")}`;
  const { data: wsData } = await sb.rpc("create_workspace_for_new_user", {
    p_user_id: userId,
    p_workspace_name: "t4-4-smoke",
    p_wrapped_dek: wrappedParam,
  });
  workspaceId = wsData as string;

  const backend =
    await SupabaseEncryptedMirrorBackend.forWorkspace(workspaceId);

  console.log("\n→ Seeding files");
  // Write order matters for recentFiles: foo first, then deep, then bar last.
  await backend.writeFile("foo.md", "alpha");
  await trackObject("foo.md");
  await new Promise((r) => setTimeout(r, 50)); // ensure mtime separation
  await backend.writeFile("subdir/nested/baz.md", "gamma");
  await trackObject("subdir/nested/baz.md");
  await new Promise((r) => setTimeout(r, 50));
  await backend.writeFile("subdir/bar.md", "beta");
  await trackObject("subdir/bar.md");

  console.log("\n→ listFiles");
  const all = await backend.listFiles();
  check(
    "listFiles() returns all 3 paths",
    all.length === 3 &&
      all.includes("foo.md") &&
      all.includes("subdir/bar.md") &&
      all.includes("subdir/nested/baz.md"),
    all,
  );

  const inSubdir = await backend.listFiles("subdir");
  check(
    "listFiles('subdir') returns 2 paths under subdir/",
    inSubdir.length === 2 &&
      inSubdir.includes("subdir/bar.md") &&
      inSubdir.includes("subdir/nested/baz.md"),
    inSubdir,
  );

  const inSubdirShallow = await backend.listFiles("subdir", false);
  check(
    "listFiles('subdir', recursive=false) returns only direct children",
    inSubdirShallow.length === 1 && inSubdirShallow[0] === "subdir/bar.md",
    inSubdirShallow,
  );

  const topLevel = await backend.listFiles(undefined, false);
  check(
    "listFiles(undefined, recursive=false) returns only top-level paths",
    topLevel.length === 1 && topLevel[0] === "foo.md",
    topLevel,
  );

  const empty = await backend.listFiles("nope");
  check(
    "listFiles('nope') returns empty array",
    Array.isArray(empty) && empty.length === 0,
  );

  // Trailing slash should behave the same as no slash
  const withSlash = await backend.listFiles("subdir/");
  check(
    "listFiles('subdir/') matches listFiles('subdir')",
    withSlash.length === 2,
    withSlash,
  );

  console.log("\n→ exists");
  check("exists('foo.md') = true", (await backend.exists("foo.md")) === true);
  check(
    "exists('subdir/bar.md') = true",
    (await backend.exists("subdir/bar.md")) === true,
  );
  check(
    "exists('nope.md') = false",
    (await backend.exists("nope.md")) === false,
  );
  check(
    "exists('   ') = false (no throw, matches LocalBackend)",
    (await backend.exists("   ")) === false,
  );

  console.log("\n→ stat");
  const stat1 = await backend.stat("foo.md");
  check(
    "stat('foo.md').size = plaintext byte length (5)",
    stat1.size === 5,
    stat1.size,
  );
  const ageMs = Date.now() - stat1.modifiedAt.getTime();
  check(
    "stat('foo.md').modifiedAt within 10s of now",
    ageMs >= 0 && ageMs < 10_000,
    { ageMs },
  );

  let statErr: unknown = null;
  try {
    await backend.stat("nope.md");
  } catch (e) {
    statErr = e;
  }
  check(
    "stat('nope.md') throws NotFoundError (typed)",
    statErr instanceof NotFoundError,
    statErr,
  );

  console.log("\n→ recentFiles");
  const recent2 = await backend.recentFiles(2);
  // Write order was: foo → baz → bar (latest)
  check(
    "recentFiles(2) most recent first: bar then baz",
    recent2.length === 2 &&
      recent2[0] === "subdir/bar.md" &&
      recent2[1] === "subdir/nested/baz.md",
    recent2,
  );

  const recent99 = await backend.recentFiles(99);
  check(
    "recentFiles(99) returns all 3 (n > total)",
    recent99.length === 3,
    recent99,
  );

  const recent0 = await backend.recentFiles(0);
  check("recentFiles(0) returns []", recent0.length === 0);

  const recentNeg = await backend.recentFiles(-5);
  check("recentFiles(-5) returns []", recentNeg.length === 0);

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
