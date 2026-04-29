/**
 * Stage 1 T6.4 — /mcp end-to-end multi-workspace isolation smoke.
 *
 * Provisions two independent users (A + B) with their own workspaces +
 * DEKs, spawns ONE HTTP server, drives independent OAuth handshakes, and
 * asserts:
 *   - bearer A → /mcp → vault_files row in workspace A only
 *   - bearer B → /mcp → vault_files row in workspace B only
 *   - bearer A's token does NOT see workspace B's files (and vice versa)
 *
 * This is the load-bearing T6 invariant: the workspace_id flows from the
 * oauth_tokens row into req.workspaceId into getBackend(...), and there
 * is no path by which a token issued for one workspace can write to or
 * read from another.
 *
 * Run: tsx scripts/test-mcp-end-to-end.ts
 *   Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TAPROOT_KEK in env.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nukeWorkspace } from "../src/utils/supabase-mirror.js";
import {
  provisionTenant,
  obtainBearer,
  waitForHealth,
  sb,
  type Tenant,
} from "./lib/test-fixtures.js";

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

const PORT = 3880;
const BASE = `http://localhost:${PORT}`;
const PASSWORD = "t6-4-pw-12345";

async function plant(bearer: string, path: string, content: string) {
  return mcpCall(bearer, "tools/call", {
    name: "garden_plant",
    arguments: { path, content },
  });
}

async function mcpCall(
  bearer: string,
  method: string,
  params: unknown,
): Promise<{ status: number; json: any }> {
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1e9),
      method,
      params,
    }),
  });
  const text = await r.text();
  if (text.startsWith("event:") || text.includes("\ndata: ")) {
    const dataLine = text
      .split("\n")
      .find((l) => l.startsWith("data: "))
      ?.slice("data: ".length);
    if (dataLine) return { status: r.status, json: JSON.parse(dataLine) };
  }
  try {
    return { status: r.status, json: JSON.parse(text) };
  } catch {
    return { status: r.status, json: text };
  }
}

let serverProc: ChildProcess | null = null;
let tmpVault: string | null = null;
const tenants: Tenant[] = [];

try {
  console.log("\n→ Provisioning two independent tenants");
  const A = await provisionTenant({ testName: "t6-4", suffix: "A" });
  tenants.push(A);
  check("tenant A provisioned", typeof A.workspaceId === "string");
  const B = await provisionTenant({ testName: "t6-4", suffix: "B" });
  tenants.push(B);
  check("tenant B provisioned", typeof B.workspaceId === "string");
  check(
    "tenant A and B have distinct workspace_ids",
    A.workspaceId !== B.workspaceId,
  );

  console.log(`\n→ Spawning server (port ${PORT})`);
  tmpVault = mkdtempSync(join(tmpdir(), "taproot-mcp-e2e-"));
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(PORT) };
  delete env.SYNAPSE_PASSWORD;
  serverProc = spawn(
    "npx",
    ["tsx", "src/index.ts", tmpVault, "--http", "--port", String(PORT)],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const logs: string[] = [];
  serverProc.stdout?.on("data", (d) => logs.push(`[stdout] ${d}`));
  serverProc.stderr?.on("data", (d) => logs.push(`[stderr] ${d}`));
  if (!(await waitForHealth(BASE))) {
    console.error(logs.slice(-20).join(""));
    throw new Error("server boot failed");
  }
  check("server up at /health", true);

  console.log("\n→ Obtain bearers via independent OAuth handshakes");
  const bearerA = (
    await obtainBearer({
      baseUrl: BASE,
      email: A.email,
      password: PASSWORD,
      testName: "t6-4",
    })
  ).bearer;
  const bearerB = (
    await obtainBearer({
      baseUrl: BASE,
      email: B.email,
      password: PASSWORD,
      testName: "t6-4",
    })
  ).bearer;
  check(
    "bearers issued for both tenants",
    bearerA.length > 0 && bearerB.length > 0,
  );
  check(
    "bearers are distinct opaque tokens",
    bearerA !== bearerB,
    `A=${bearerA.slice(0, 6)} B=${bearerB.slice(0, 6)}`,
  );

  console.log("\n→ Each bearer writes to its own workspace");
  const planted = await plant(bearerA, "inbox/from-A.md", "# from tenant A\n");
  check(
    "plant via bearer A returns 200 (no isError)",
    planted.status === 200 && !planted.json?.result?.isError,
    planted,
  );
  const plantedB = await plant(bearerB, "inbox/from-B.md", "# from tenant B\n");
  check(
    "plant via bearer B returns 200 (no isError)",
    plantedB.status === 200 && !plantedB.json?.result?.isError,
    plantedB,
  );

  console.log("\n→ Workspace isolation: no cross-pollination in vault_files");
  const { data: rowsA } = await sb
    .from("vault_files")
    .select("path")
    .eq("workspace_id", A.workspaceId)
    .is("deleted_at", null);
  const { data: rowsB } = await sb
    .from("vault_files")
    .select("path")
    .eq("workspace_id", B.workspaceId)
    .is("deleted_at", null);
  check(
    "workspace A has 'inbox/from-A.md' and NOT 'inbox/from-B.md'",
    Array.isArray(rowsA) &&
      rowsA.some((r) => r.path === "inbox/from-A.md") &&
      !rowsA.some((r) => r.path === "inbox/from-B.md"),
    rowsA,
  );
  check(
    "workspace B has 'inbox/from-B.md' and NOT 'inbox/from-A.md'",
    Array.isArray(rowsB) &&
      rowsB.some((r) => r.path === "inbox/from-B.md") &&
      !rowsB.some((r) => r.path === "inbox/from-A.md"),
    rowsB,
  );

  console.log(
    "\n→ Bearer A reading 'from-B.md' must NOT find workspace B's row",
  );
  // garden_read returns isError on miss in this workspace's vault_files.
  // The fact that B wrote a file at the SAME relative path means the
  // strongest test is: A trying to read 'from-B.md' should miss because
  // workspace A doesn't have a row at that path (only workspace B does).
  const readMiss = await mcpCall(bearerA, "tools/call", {
    name: "garden_read",
    arguments: { path: "inbox/from-B.md" },
  });
  const readMissText: string = readMiss.json?.result?.content?.[0]?.text ?? "";
  check(
    "bearer A read of 'inbox/from-B.md' returns isError (file not in A's vault)",
    readMiss.json?.result?.isError === true,
    {
      isError: readMiss.json?.result?.isError,
      text: readMissText.slice(0, 80),
    },
  );

  console.log("\n→ Bearer A reading its OWN file works");
  const readHit = await mcpCall(bearerA, "tools/call", {
    name: "garden_read",
    arguments: { path: "inbox/from-A.md" },
  });
  const readHitText: string = readHit.json?.result?.content?.[0]?.text ?? "";
  check(
    "bearer A read of 'inbox/from-A.md' returns content",
    readHit.json?.result?.isError !== true &&
      readHitText.includes("from tenant A"),
    readHitText.slice(0, 80),
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
  console.log("\nCleanup:");
  if (serverProc && !serverProc.killed) {
    serverProc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const t of tenants) {
    try {
      await nukeWorkspace(sb, t.workspaceId, t.userId);
    } catch {}
    await sb.from("workspaces").delete().eq("id", t.workspaceId);
    await sb.auth.admin.deleteUser(t.userId);
  }
  console.log(`  cleaned up ${tenants.length} tenants`);
  if (tmpVault) {
    rmSync(tmpVault, { recursive: true, force: true });
  }
}

if (fail > 0) process.exit(1);
