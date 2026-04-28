/**
 * Stage 1 T4.7 — backend-cache smoke.
 *
 * Asserts:
 *   - getBackend(id) twice within TTL → same instance, single kek_unwrap
 *     audit row (DEK was unwrapped exactly once)
 *   - evict(id) → next getBackend constructs fresh (kek_unwrap count = 2)
 *   - clearAll() also forces fresh construction
 *   - TTL expiry forces fresh construction (uses __setTtlMsForTest hook
 *     to avoid sleeping 5 minutes)
 *   - Two different workspace ids return distinct cached instances
 *
 * Cleans up workspace + user on exit.
 */
import { createClient } from "@supabase/supabase-js";
import { generateDek, wrapDek } from "../src/api/crypto.js";
import {
  getBackend,
  evict,
  clearAll,
  __setTtlMsForTest,
  __resetTtlMsForTest,
} from "../src/utils/backend-cache.js";

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

async function unwrapCount(workspaceId: string): Promise<number> {
  const { count } = await sb
    .from("audit_log")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("operation", "kek_unwrap");
  return count ?? 0;
}

async function provisionWorkspace(label: string): Promise<{
  userId: string;
  workspaceId: string;
}> {
  const email = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@taproot-test.local`;
  const { data: userData } = await sb.auth.admin.createUser({
    email,
    password: "t4-7-pw-12345",
    email_confirm: true,
  });
  const userId = userData!.user!.id;
  const wrapped = wrapDek(generateDek());
  const wrappedParam = `\\x${wrapped.toString("hex")}`;
  const { data: wsData } = await sb.rpc("create_workspace_for_new_user", {
    p_user_id: userId,
    p_workspace_name: label,
    p_wrapped_dek: wrappedParam,
  });
  return { userId, workspaceId: wsData as string };
}

const provisioned: Array<{ userId: string; workspaceId: string }> = [];

try {
  console.log("\n→ Provisioning workspace A");
  const a = await provisionWorkspace("t4-7-a");
  provisioned.push(a);

  // Start clean — production uses module-level cache, may have entries
  // from earlier in the run / earlier tests.
  clearAll();

  console.log("\n→ Cache hit within TTL");
  const b1 = await getBackend(a.workspaceId);
  const b2 = await getBackend(a.workspaceId);
  check("two getBackend(same id) calls return the SAME instance", b1 === b2);
  check(
    "kek_unwrap audit count = 1 after two cache-hit calls",
    (await unwrapCount(a.workspaceId)) === 1,
  );

  console.log("\n→ evict() forces fresh construction");
  evict(a.workspaceId);
  const b3 = await getBackend(a.workspaceId);
  check("getBackend after evict returns a NEW instance", b3 !== b1);
  check(
    "kek_unwrap audit count = 2 after evict + getBackend",
    (await unwrapCount(a.workspaceId)) === 2,
  );

  console.log("\n→ clearAll() forces fresh construction");
  clearAll();
  const b4 = await getBackend(a.workspaceId);
  check("getBackend after clearAll returns a NEW instance", b4 !== b3);
  check(
    "kek_unwrap audit count = 3 after clearAll + getBackend",
    (await unwrapCount(a.workspaceId)) === 3,
  );

  console.log("\n→ TTL expiry forces fresh construction");
  // Set a tiny TTL, then sleep past it. (Test hook: production never
  // calls this.)
  __setTtlMsForTest(50);
  const b5 = await getBackend(a.workspaceId);
  await new Promise((r) => setTimeout(r, 80));
  const b6 = await getBackend(a.workspaceId);
  __resetTtlMsForTest();
  check("getBackend after TTL expiry returns a NEW instance", b5 !== b6);
  check(
    "kek_unwrap audit count = 5 after two TTL-expiry constructions",
    (await unwrapCount(a.workspaceId)) === 5,
  );

  console.log("\n→ Different workspaces are cached independently");
  const b = await provisionWorkspace("t4-7-b");
  provisioned.push(b);
  const aBack = await getBackend(a.workspaceId);
  const bBack = await getBackend(b.workspaceId);
  check(
    "getBackend(workspace_a) and getBackend(workspace_b) return distinct instances",
    aBack !== bBack,
  );
  // After clearAll above: a got 1 unwrap (b6), then 1 more here (aBack) = 2 since clearAll
  // Total kek_unwrap rows for a since start: 3 (initial cache+evict+clearAll) + 2 (TTL) + 1 (aBack since clearAll-then-TTL) = 6
  // The exact accounting matters less than: each workspace gets its own cache slot.
  check(
    "workspace_b has its own kek_unwrap audit row from this getBackend",
    (await unwrapCount(b.workspaceId)) === 1,
  );

  // After workspace_a cache settles, calling again should return the SAME
  // instance for a (cache hit) — proving the second workspace didn't
  // evict the first.
  const aBackAgain = await getBackend(a.workspaceId);
  check(
    "workspace_a still cached after workspace_b lookup",
    aBack === aBackAgain,
  );

  console.log(`\n${pass} pass, ${fail} fail`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
} finally {
  console.log("\nCleanup:");
  __resetTtlMsForTest();
  clearAll();
  for (const p of provisioned) {
    await sb.from("workspaces").delete().eq("id", p.workspaceId);
    await sb.auth.admin.deleteUser(p.userId);
  }
  console.log(`  cleaned up ${provisioned.length} workspaces + users`);
}

if (fail > 0) process.exit(1);
