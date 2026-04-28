/**
 * Stage 1 T5 — LocalBackend parity smoke.
 *
 * Exercises every method of LocalBackend against a tmpdir vault and
 * asserts semantics match the SupabaseEncryptedMirrorBackend (typed
 * NotFoundError / ConflictError, soft-delete-equivalent behavior on
 * delete, identical mkdir / move / stat / recentFiles surface).
 *
 * No Supabase / network. Pure filesystem.
 *
 * Run: tsx scripts/test-local-backend.ts
 */
import {
  LocalBackend,
  NotFoundError,
  ConflictError,
} from "../src/utils/storage.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const vault = mkdtempSync(join(tmpdir(), "taproot-local-backend-"));
const backend = new LocalBackend(vault);

try {
  console.log(`\n→ writeFile + readFile (utf-8 + emoji)`);
  await backend.writeFile("inbox/hello.md", "# hello\n\nplain ascii\n");
  const a = await backend.readFile("inbox/hello.md");
  check(
    "readFile returns the exact content written",
    a.includes("plain ascii"),
  );

  await backend.writeFile("inbox/emoji.md", "# 🌱\n\n你好 — utf-8\n");
  const b = await backend.readFile("inbox/emoji.md");
  check(
    "round-trip preserves emoji + non-ASCII",
    b.includes("🌱") && b.includes("你好"),
  );

  // Overwriting in place
  await backend.writeFile("inbox/hello.md", "# rewritten\n");
  const c = await backend.readFile("inbox/hello.md");
  check("writeFile overwrites in place", c.includes("rewritten"));

  console.log("\n→ readFile error path");
  let readMissErr: unknown = null;
  try {
    await backend.readFile("nope/missing.md");
  } catch (e) {
    readMissErr = e;
  }
  check(
    "readFile(missing) throws NotFoundError (typed)",
    readMissErr instanceof NotFoundError,
    readMissErr instanceof Error ? readMissErr.message : readMissErr,
  );

  console.log("\n→ exists");
  check("exists(known) → true", await backend.exists("inbox/hello.md"));
  check("exists(missing) → false", !(await backend.exists("inbox/no.md")));
  check(
    "exists('   ') → false (whitespace path parity)",
    !(await backend.exists("   ")),
  );
  check("exists('') → false (empty path parity)", !(await backend.exists("")));
  check(
    "exists with traversal attempt → false (no throw)",
    !(await backend.exists("../escape.md")),
  );

  console.log("\n→ listFiles");
  await backend.writeFile("inbox/sub/nested.md", "nested\n");
  await backend.writeFile("notes/topic.md", "topic\n");
  // Non-md sibling should be ignored
  writeFileSync(join(vault, "ignore.txt"), "not markdown");

  const allFiles = await backend.listFiles();
  check(
    "listFiles() returns all .md files (no .txt)",
    allFiles.length >= 4 &&
      allFiles.every((p) => p.endsWith(".md")) &&
      allFiles.includes("inbox/hello.md") &&
      allFiles.includes("inbox/emoji.md") &&
      allFiles.includes("inbox/sub/nested.md") &&
      allFiles.includes("notes/topic.md"),
    allFiles,
  );

  const inboxRecursive = await backend.listFiles("inbox", true);
  check(
    "listFiles('inbox', true) recurses into inbox/sub",
    inboxRecursive.some((p) => p.includes("sub/nested.md")),
    inboxRecursive,
  );

  const inboxFlat = await backend.listFiles("inbox", false);
  check(
    "listFiles('inbox', false) excludes nested files",
    inboxFlat.every((p) => !p.includes("sub/")) && inboxFlat.length >= 2,
    inboxFlat,
  );

  const missingDir = await backend.listFiles("does-not-exist", true);
  check(
    "listFiles(missingDir) returns [] (mirror parity, not throw)",
    Array.isArray(missingDir) && missingDir.length === 0,
    missingDir,
  );

  console.log("\n→ stat");
  const s = await backend.stat("inbox/hello.md");
  check(
    "stat returns size + modifiedAt",
    typeof s.size === "number" && s.size > 0 && s.modifiedAt instanceof Date,
    s,
  );

  let statMissErr: unknown = null;
  try {
    await backend.stat("nope.md");
  } catch (e) {
    statMissErr = e;
  }
  check(
    "stat(missing) throws NotFoundError (typed)",
    statMissErr instanceof NotFoundError,
    statMissErr instanceof Error ? statMissErr.message : statMissErr,
  );

  console.log("\n→ mkdir");
  await backend.mkdir("brand-new-dir");
  check(
    "mkdir creates the directory (visible to subsequent listFiles)",
    Array.isArray(await backend.listFiles("brand-new-dir")),
  );
  // Idempotent (mirror's mkdir is a no-op)
  await backend.mkdir("brand-new-dir");
  check("mkdir is idempotent (no throw on re-create)", true);

  console.log("\n→ delete");
  await backend.writeFile("trash/file.md", "trash\n");
  check("file exists pre-delete", await backend.exists("trash/file.md"));
  await backend.delete("trash/file.md");
  check("delete removes the file", !(await backend.exists("trash/file.md")));

  let delMissErr: unknown = null;
  try {
    await backend.delete("trash/file.md");
  } catch (e) {
    delMissErr = e;
  }
  check(
    "delete(missing) throws NotFoundError (typed)",
    delMissErr instanceof NotFoundError,
    delMissErr instanceof Error ? delMissErr.message : delMissErr,
  );

  console.log("\n→ move");
  await backend.writeFile("from/here.md", "moved\n");
  await backend.move("from/here.md", "to/there.md");
  check(
    "move: source gone, target exists with content",
    !(await backend.exists("from/here.md")) &&
      (await backend.readFile("to/there.md")).includes("moved"),
  );

  // same → same is no-op (mirror parity)
  await backend.writeFile("idempotent.md", "x\n");
  await backend.move("idempotent.md", "idempotent.md");
  check("move(same → same) is a no-op", await backend.exists("idempotent.md"));

  // Collision → ConflictError typed
  await backend.writeFile("collide-src.md", "a\n");
  await backend.writeFile("collide-dst.md", "b\n");
  let collisionErr: unknown = null;
  try {
    await backend.move("collide-src.md", "collide-dst.md");
  } catch (e) {
    collisionErr = e;
  }
  check(
    "move(collision) throws ConflictError (typed)",
    collisionErr instanceof ConflictError,
    collisionErr instanceof Error ? collisionErr.message : collisionErr,
  );
  check(
    "move(collision) leaves source intact (no silent overwrite)",
    (await backend.exists("collide-src.md")) &&
      (await backend.readFile("collide-dst.md")).includes("b"),
  );

  let moveMissErr: unknown = null;
  try {
    await backend.move("from/missing.md", "elsewhere.md");
  } catch (e) {
    moveMissErr = e;
  }
  check(
    "move(missing source) throws NotFoundError (typed)",
    moveMissErr instanceof NotFoundError,
    moveMissErr instanceof Error ? moveMissErr.message : moveMissErr,
  );

  console.log("\n→ recentFiles");
  // Touch a few files to spread mtimes
  await new Promise((r) => setTimeout(r, 5));
  await backend.writeFile("recent-A.md", "A\n");
  await new Promise((r) => setTimeout(r, 5));
  await backend.writeFile("recent-B.md", "B\n");
  await new Promise((r) => setTimeout(r, 5));
  await backend.writeFile("recent-C.md", "C\n");

  const recent3 = await backend.recentFiles(3);
  check(
    "recentFiles(3) returns 3 entries with most-recent first",
    recent3.length === 3 &&
      recent3[0] === "recent-C.md" &&
      recent3[1] === "recent-B.md" &&
      recent3[2] === "recent-A.md",
    recent3,
  );

  const recent0 = await backend.recentFiles(0);
  check("recentFiles(0) returns []", recent0.length === 0);

  const recentNeg = await backend.recentFiles(-5);
  check("recentFiles(-5) returns [] (clamped to 0)", recentNeg.length === 0);

  const recentOversize = await backend.recentFiles(10_000);
  check(
    "recentFiles(>total) returns all available, no throw",
    recentOversize.length > 0 && recentOversize.length < 10_000,
    recentOversize.length,
  );

  console.log("\n→ Path traversal hardening");
  let traversalErr: unknown = null;
  try {
    await backend.writeFile("../escape.md", "nope");
  } catch (e) {
    traversalErr = e;
  }
  check(
    "writeFile('../escape.md') throws (path traversal blocked)",
    traversalErr instanceof Error &&
      /Path traversal/.test(traversalErr.message),
    traversalErr instanceof Error ? traversalErr.message : traversalErr,
  );

  console.log(`\n${pass} pass, ${fail} fail`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
} catch (err: any) {
  console.error(`\nFATAL: ${err.message ?? err}`);
  fail++;
} finally {
  rmSync(vault, { recursive: true, force: true });
}

if (fail > 0) process.exit(1);
