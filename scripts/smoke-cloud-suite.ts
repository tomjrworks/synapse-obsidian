/**
 * Stage 1 T6.6 — cloud smoke suite runner.
 *
 * Runs the four T6 cloud-server smokes back-to-back. Each child spawns
 * its own short-lived HTTP server, provisions its own tenants, and
 * cleans up on exit. Suite exit code = 0 only if every child passed.
 *
 *   - test-mcp-routing             (11 assertions, T6.1)
 *   - test-oauth-supabase-bridge   (12 assertions, T6.2)
 *   - test-oauth-tokens            (21 assertions, T6.3 + T6.5)
 *   - test-mcp-end-to-end          (12 assertions, T6.4 isolation)
 *
 * Run: npm run smoke:cloud
 *   Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TAPROOT_KEK in env.
 *
 * Doesn't include the onboarding HTTP smoke (`smoke:onboarding`) — that
 * one expects the dev server to be already up on :3779; the cloud suite
 * is self-contained and can run from a clean shell.
 */
import { spawnSync } from "node:child_process";

interface Suite {
  name: string;
  script: string;
}

const suites: Suite[] = [
  { name: "mcp-routing", script: "scripts/test-mcp-routing.ts" },
  { name: "oauth-bridge", script: "scripts/test-oauth-supabase-bridge.ts" },
  { name: "oauth-tokens", script: "scripts/test-oauth-tokens.ts" },
  { name: "mcp-e2e", script: "scripts/test-mcp-end-to-end.ts" },
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
console.log("Cloud smoke suite — summary");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
for (const r of results) {
  const status = r.exit === 0 && r.failed === 0 ? "✓" : "✗";
  const time = `${(r.durationMs / 1000).toFixed(1)}s`;
  console.log(
    `  ${status} ${r.name.padEnd(14)} ${String(r.passed).padStart(3)}/${String(r.passed + r.failed).padEnd(3)} pass  ${time}`,
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
