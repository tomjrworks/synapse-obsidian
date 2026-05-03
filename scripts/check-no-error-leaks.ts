/**
 * Guardrail: forbid raw error leaks in HTTP response bodies.
 *
 * Greps the user-facing HTTP surface (src/api/, src/server.ts, src/signin.ts,
 * src/oauth.ts) for forbidden patterns where err.message or an entire err
 * object would land in a response body. Use respondError / logErrorWithId
 * (src/api/respond-error.ts) instead.
 *
 * Out of scope (explicitly NOT scanned):
 *   - src/tools/*       — MCP tool responses to the model, not HTTP
 *   - src/resources.ts  — MCP resource responses, not HTTP
 *   - src/utils/*       — internal modules; throws caught upstream
 *
 * Allow per-line escape hatch with `// no-error-leaks-allow` (must be
 * justified in PR description if used).
 *
 * Run: tsx scripts/check-no-error-leaks.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const SCAN_TARGETS = [
  "src/api",
  "src/server.ts",
  "src/signin.ts",
  "src/oauth.ts",
];

const FORBIDDEN: { name: string; re: RegExp }[] = [
  {
    name: "error: err* in res.json/res.status().json",
    re: /res\.(?:status\([^)]+\)\.)?json\(\s*\{[^}]*\berror\s*:\s*err\b/,
  },
  {
    name: "detail: err* in res.json/res.status().json",
    re: /res\.(?:status\([^)]+\)\.)?json\(\s*\{[^}]*\bdetail\s*:\s*err\b/,
  },
];

const ALLOW_TAG = "no-error-leaks-allow";

type Hit = { file: string; line: number; rule: string; text: string };

function walk(p: string): string[] {
  const abs = resolve(ROOT, p);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return [];
  }
  if (st.isFile()) return abs.endsWith(".ts") ? [abs] : [];
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    if (name === "node_modules" || name === "dist") continue;
    out.push(...walk(join(p, name)));
  }
  return out;
}

const files = SCAN_TARGETS.flatMap(walk);
const hits: Hit[] = [];

for (const file of files) {
  const lines = readFileSync(file, "utf-8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (text.includes(ALLOW_TAG)) continue;
    for (const { name, re } of FORBIDDEN) {
      if (re.test(text)) {
        hits.push({
          file: file.replace(`${ROOT}/`, ""),
          line: i + 1,
          rule: name,
          text: text.trim(),
        });
      }
    }
  }
}

if (hits.length > 0) {
  console.error(
    `\nFound ${hits.length} forbidden error-leak pattern(s).\nUse respondError / logErrorWithId from src/api/respond-error.ts.\n`,
  );
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  [${h.rule}]`);
    console.error(`    > ${h.text}`);
  }
  console.error(
    `\nIf one of these is a deliberate exception, add // ${ALLOW_TAG} on the same line and explain in the PR description.\n`,
  );
  process.exit(1);
}

console.log(
  `no-error-leaks: clean (${files.length} file(s) scanned across ${SCAN_TARGETS.length} target(s))`,
);
