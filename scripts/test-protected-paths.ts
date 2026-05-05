/**
 * Smoke: PROTECTED_PATHS canonical-form check.
 *
 * Locks H1 from the 2026-05-05 security audit. The May 1 fix took 4 days to
 * discover its incomplete normalization (raw-string Set match bypassed by
 * `./CLAUDE.md`, `claude.md` on APFS, etc.). This smoke catches the next
 * variant in <1 min.
 *
 * Run: tsx scripts/test-protected-paths.ts (or npm run smoke:protected)
 */
import {
  checkProtected,
  type ProtectionResult,
} from "../src/utils/path-guard.js";

type Case = {
  input: string;
  expectedKind: ProtectionResult["kind"];
  note: string;
};

const cases: Case[] = [
  { input: "CLAUDE.md", expectedKind: "protected", note: "exact, canonical" },
  { input: "claude.md", expectedKind: "protected", note: "case bypass" },
  { input: "./CLAUDE.md", expectedKind: "protected", note: "./ bypass" },
  {
    input: "CLAUDE.md/",
    expectedKind: "protected",
    note: "trailing-slash bypass",
  },
  {
    input: "foo/../CLAUDE.md",
    expectedKind: "protected",
    note: "traversal bypass",
  },
  {
    input: "foo\\..\\CLAUDE.md",
    expectedKind: "invalid",
    note: "backslash reject",
  },
  {
    input: "notes/CLAUDE.md",
    expectedKind: "protected",
    note: "basename-anywhere",
  },
  {
    input: "deep/path/to/claude.md",
    expectedKind: "protected",
    note: "deep basename match",
  },
  { input: "index.md", expectedKind: "protected", note: "exact" },
  { input: ".taproot/config.json", expectedKind: "protected", note: "exact" },
  { input: "/etc/passwd", expectedKind: "invalid", note: "absolute" },
  { input: "../escape", expectedKind: "invalid", note: "traversal escape" },
  { input: "notes/foo.md", expectedKind: "ok", note: "legitimate write" },
  { input: "CLAUDE.txt", expectedKind: "ok", note: "claude prefix, not match" },
];

let passed = 0;
let failed = 0;

for (const c of cases) {
  const result = checkProtected(c.input);
  const ok = result.kind === c.expectedKind;
  const status = ok ? "PASS" : "FAIL";
  const detail =
    result.kind === "protected"
      ? ` → canonical="${result.canonical}"`
      : result.kind === "invalid"
        ? ` → ${result.reason}`
        : "";
  console.log(
    `[${status}] ${JSON.stringify(c.input).padEnd(28)} expected=${c.expectedKind.padEnd(9)} got=${result.kind.padEnd(9)} (${c.note})${detail}`,
  );
  if (ok) passed++;
  else failed++;
}

console.log(`\n${passed}/${cases.length} cases passed.`);
if (failed > 0) {
  console.error(`${failed} FAILED — H1 regression.`);
  process.exit(1);
}
