/**
 * Stage 1 T4.8 — mirror smoke suite runner.
 *
 * Runs every dedicated mirror smoke back-to-back:
 *   - test-content-crypto       (11 unit assertions, no DB)
 *   - test-forworkspace         (7 assertions, factory + audit)
 *   - test-mirror-write         (19 assertions, writeFile)
 *   - test-mirror-read          (8 assertions, readFile + AEAD)
 *   - test-mirror-metadata      (17 assertions, list/exists/stat/recent)
 *   - test-mirror-mutate        (25 assertions, delete/move/mkdir)
 *   - test-mirror-nuke          (17 assertions, /api/leave end-to-end)
 *   - test-backend-cache        (11 assertions, cache primitive)
 *
 * Each child smoke does its own provisioning + cleanup. Suite-level
 * exit code = 0 only if every child exited 0.
 *
 * Run: npm run smoke:mirror
 *   Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TAPROOT_KEK in env.
 *
 * Doesn't run the onboarding HTTP smoke (`scripts/smoke-onboarding.ts`)
 * since that one needs the dev server already listening on :3779.
 * Run that one separately with `npm run smoke:onboarding` after
 * `npm run dev` in another terminal.
 */
import { spawnSync } from "node:child_process";

interface Suite {
  name: string;
  script: string;
}

const suites: Suite[] = [
  { name: "content-crypto", script: "scripts/test-content-crypto.ts" },
  { name: "forworkspace", script: "scripts/test-forworkspace.ts" },
  { name: "mirror-write", script: "scripts/test-mirror-write.ts" },
  { name: "mirror-read", script: "scripts/test-mirror-read.ts" },
  { name: "mirror-metadata", script: "scripts/test-mirror-metadata.ts" },
  { name: "mirror-mutate", script: "scripts/test-mirror-mutate.ts" },
  { name: "mirror-nuke", script: "scripts/test-mirror-nuke.ts" },
  { name: "backend-cache", script: "scripts/test-backend-cache.ts" },
];

const results: Array<{
  name: string;
  passed: number;
  failed: number;
  exit: number;
  durationMs: number;
}> = [];

const t0Suite = Date.now();

for (const suite of suites) {
  console.log(`\n━━━ ${suite.name} (${suite.script}) ━━━`);
  const t0 = Date.now();
  const r = spawnSync("npx", ["tsx", suite.script], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: process.env,
  });
  const durationMs = Date.now() - t0;
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";

  // Parse "N pass, M fail" line
  const match = stdout.match(/(\d+) pass,\s*(\d+) fail/);
  const passed = match ? Number(match[1]) : 0;
  const failed = match ? Number(match[2]) : 0;
  const exit = r.status ?? 1;

  process.stdout.write(stdout);
  if (stderr.trim()) process.stderr.write(stderr);

  results.push({ name: suite.name, passed, failed, exit, durationMs });
}

const totalDur = Date.now() - t0Suite;
const totalPass = results.reduce((a, r) => a + r.passed, 0);
const totalFail = results.reduce((a, r) => a + r.failed, 0);
const failedSuites = results.filter((r) => r.exit !== 0 || r.failed > 0);

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("Mirror smoke suite — summary");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
for (const r of results) {
  const status = r.exit === 0 && r.failed === 0 ? "✓" : "✗";
  const time = `${(r.durationMs / 1000).toFixed(1)}s`;
  console.log(
    `  ${status} ${r.name.padEnd(18)} ${String(r.passed).padStart(3)}/${String(r.passed + r.failed).padEnd(3)} pass  ${time}`,
  );
}
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(
  `Total: ${totalPass}/${totalPass + totalFail} assertions  ·  ${(totalDur / 1000).toFixed(1)}s wall time`,
);
if (failedSuites.length > 0) {
  console.log(
    `\n${failedSuites.length} suite(s) FAILED: ${failedSuites.map((s) => s.name).join(", ")}`,
  );
  process.exit(1);
}
console.log("\nALL GREEN");
