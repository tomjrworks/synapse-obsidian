/**
 * Stage 1 Task 2 — full onboarding-API smoke.
 *
 * Provisions a test user via the Supabase Auth admin API (bypasses
 * Supabase's MX-record email validation that rejects @example.com etc.),
 * mirrors the /api/signup atomic flow via the same PL/pgSQL function,
 * obtains a real JWT via POST /api/login, then exercises every Stage 1
 * onboarding endpoint over HTTP.
 *
 * Cleans up the test user, workspace, and any vault writes on exit
 * (best-effort — partial cleanup logged).
 *
 * Prereqs: server running at TAPROOT_BASE_URL (default http://localhost:3779),
 * env loaded with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + TAPROOT_KEK.
 */
import { generateDek, wrapDek } from "../src/api/crypto.js";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { obtainBearer, sb } from "./lib/test-fixtures.js";

const BASE = process.env.TAPROOT_BASE_URL ?? "http://localhost:3779";

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

async function http(
  method: string,
  path: string,
  jwt?: string | null,
  body?: unknown,
): Promise<{ status: number; json: any; text: string }> {
  const headers: Record<string, string> = {};
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: r.status, json, text };
}

(async () => {
  console.log(`Stage 1 T2 onboarding API smoke against ${BASE}\n`);

  // Pre-flight: server reachable
  const ping = await http("GET", "/api/_ping");
  check(
    "server is up at /api/_ping",
    ping.status === 200 && ping.json?.ok,
    ping,
  );
  if (ping.status !== 200) {
    console.error(
      `\nServer not reachable. Start it with:\n  set -a && source .env && set +a && npx tsx src/index.ts <vault> --http --port 3779`,
    );
    process.exit(2);
  }

  // 1. Provision test user via admin API (mirrors what /api/signup does
  //    once Supabase auth.signUp has returned a user). This validates the
  //    bytea + RPC path identically to /api/signup.
  const testEmail = `smoke-${Date.now()}@gmail.com`;
  const testPassword = "smoke-password-12345";

  const created = await sb.auth.admin.createUser({
    email: testEmail,
    password: testPassword,
    email_confirm: true,
  });
  check("admin.createUser succeeds", !created.error, created.error?.message);
  const userId = created.data.user!.id;

  const dek = generateDek();
  const wrapped = wrapDek(dek);
  const wrappedParam = `\\x${wrapped.toString("hex")}`;
  const rpc = await sb.rpc("create_workspace_for_new_user", {
    p_user_id: userId,
    p_workspace_name: "Smoke Garden",
    p_wrapped_dek: wrappedParam,
  });
  check("atomic workspace RPC succeeds", !rpc.error, rpc.error?.message);
  const workspaceId = rpc.data as string;

  // Verify the 4 rows exist
  const { data: ws } = await sb
    .from("workspaces")
    .select("id, settings, owner_user_id")
    .eq("id", workspaceId)
    .single();
  check(
    "workspaces row exists with onboarding_step=persona",
    ws?.settings?.onboarding_step === "persona" && ws?.owner_user_id === userId,
    ws,
  );
  const { data: members } = await sb
    .from("workspace_members")
    .select("workspace_id, user_id, role")
    .eq("workspace_id", workspaceId);
  check(
    "workspace_members row created with role=owner",
    members?.length === 1 && members[0].role === "owner",
    members,
  );
  const { data: keys } = await sb
    .from("tenant_keys")
    .select("workspace_id, wrapped_dek")
    .eq("workspace_id", workspaceId);
  check(
    "tenant_keys row created with wrapped_dek",
    keys?.length === 1 && !!keys[0].wrapped_dek,
    keys,
  );

  // 2. /api/login over HTTP — gets us a real JWT
  const login = await http("POST", "/api/login", null, {
    email: testEmail,
    password: testPassword,
  });
  check(
    "POST /api/login returns 200 + JWT",
    login.status === 200 && !!login.json?.jwt,
    login.json,
  );
  const jwt: string = login.json.jwt;

  // 3. Auth gate: /api/me without JWT → 401
  const meNoAuth = await http("GET", "/api/me");
  check(
    "GET /api/me without JWT → 401",
    meNoAuth.status === 401,
    meNoAuth.json,
  );

  // 4. /api/me with JWT → workspace_id + initial state
  const me1 = await http("GET", "/api/me", jwt);
  check(
    "GET /api/me returns workspace_id + onboarding_step=persona + empty traits",
    me1.status === 200 &&
      me1.json?.workspace_id === workspaceId &&
      me1.json?.onboarding_step === "persona" &&
      Array.isArray(me1.json?.persona_traits) &&
      me1.json.persona_traits.length === 0,
    me1.json,
  );

  // 5. /api/onboarding/step → persists; /me reflects on next read
  const step1 = await http("POST", "/api/onboarding/step", jwt, {
    step: "clients",
  });
  check(
    "POST /api/onboarding/step accepts valid step",
    step1.status === 200,
    step1.json,
  );
  const meAfterStep = await http("GET", "/api/me", jwt);
  check(
    "GET /api/me reflects onboarding_step=clients",
    meAfterStep.json?.onboarding_step === "clients",
    meAfterStep.json,
  );
  const stepBad = await http("POST", "/api/onboarding/step", jwt, {
    step: "bogus",
  });
  check(
    "POST /api/onboarding/step rejects invalid step",
    stepBad.status === 400,
    stepBad.json,
  );

  // 6. /api/persona → multi-trait persists; /me reflects
  const persona1 = await http("POST", "/api/persona", jwt, {
    traits: ["founder", "writer-researcher"],
    freetext: "I run a small AI startup and write essays on the side.",
  });
  check(
    "POST /api/persona accepts multi-trait",
    persona1.status === 200,
    persona1.json,
  );
  const meAfterPersona = await http("GET", "/api/me", jwt);
  check(
    "GET /api/me reflects persona_traits + freetext",
    meAfterPersona.json?.persona_traits?.length === 2 &&
      meAfterPersona.json?.persona_traits.includes("founder") &&
      meAfterPersona.json?.persona_traits.includes("writer-researcher") &&
      typeof meAfterPersona.json?.persona_freetext === "string",
    meAfterPersona.json,
  );
  const personaBad = await http("POST", "/api/persona", jwt, {
    traits: ["founder", "rocket-scientist"],
  });
  check(
    "POST /api/persona rejects unknown trait",
    personaBad.status === 400,
    personaBad.json,
  );

  // 7. /api/clients/setup-info → 8 entries
  const setup = await http("GET", "/api/clients/setup-info", jwt);
  check(
    "GET /api/clients/setup-info returns 8 client entries",
    setup.status === 200 &&
      Array.isArray(setup.json?.clients) &&
      setup.json.clients.length === 8,
    setup.json?.clients?.length,
  );
  check(
    "every client entry has {id, label, path, payload, instructions_md, screenshot_url}",
    Array.isArray(setup.json?.clients) &&
      setup.json.clients.every(
        (c: any) =>
          c.id &&
          c.label &&
          c.path &&
          c.payload &&
          c.instructions_md &&
          c.screenshot_url,
      ),
    setup.json?.clients?.[0],
  );

  // 8. /api/clients/:id/connected → appends-unique
  const connected1 = await http(
    "POST",
    "/api/clients/claude-ai/connected",
    jwt,
  );
  check(
    "POST /api/clients/claude-ai/connected returns 200 + claude-ai in list",
    connected1.status === 200 &&
      connected1.json?.connected_clients?.includes("claude-ai"),
    connected1.json,
  );
  const connectedDup = await http(
    "POST",
    "/api/clients/claude-ai/connected",
    jwt,
  );
  check(
    "POST /api/clients/claude-ai/connected dedupes",
    connectedDup.json?.connected_clients?.filter(
      (c: string) => c === "claude-ai",
    ).length === 1,
    connectedDup.json,
  );
  const connectedBad = await http(
    "POST",
    "/api/clients/not-a-client/connected",
    jwt,
  );
  check(
    "POST /api/clients/<unknown>/connected returns 400",
    connectedBad.status === 400,
    connectedBad.json,
  );

  // 9. /api/helper/status → installed:false (no helper_devices row yet)
  const helperStatus = await http("GET", "/api/helper/status", jwt);
  check(
    "GET /api/helper/status with no device → installed:false",
    helperStatus.status === 200 && helperStatus.json?.installed === false,
    helperStatus.json,
  );

  // 10. /api/helper/pair-token → token + expires_at
  const pairToken = await http("POST", "/api/helper/pair-token", jwt);
  check(
    "POST /api/helper/pair-token returns token + expires_at",
    pairToken.status === 200 &&
      typeof pairToken.json?.token === "string" &&
      pairToken.json.token.length > 20,
    pairToken.json,
  );
  // Verify it landed in pair_tokens
  const { data: ptRow } = await sb
    .from("pair_tokens")
    .select("token, workspace_id, expires_at")
    .eq("token", pairToken.json?.token)
    .single();
  check(
    "pair_tokens row written with correct workspace_id",
    ptRow?.workspace_id === workspaceId,
    ptRow,
  );

  // 11. /api/first-wow → writes + verifies round-trip
  const firstWow = await http("POST", "/api/first-wow", jwt, {
    remembered_text: "Tom prefers Discord over Telegram for notifications.",
  });
  check(
    "POST /api/first-wow returns status:verified + path",
    firstWow.status === 200 &&
      firstWow.json?.status === "verified" &&
      typeof firstWow.json?.path === "string",
    firstWow.json,
  );
  const firstWowBad = await http("POST", "/api/first-wow", jwt, {
    remembered_text: "",
  });
  check(
    "POST /api/first-wow rejects empty text",
    firstWowBad.status === 400,
    firstWowBad.json,
  );

  // 11b. B1 cross-flow proof: a /api/first-wow write (Supabase JWT auth, /api
  //      path) must be readable via /mcp (OAuth bearer auth, MCP path) for
  //      the same workspace. Pre-B1 this failed because /api/first-wow wrote
  //      to the cloud server's bootstrap LocalBackend while /mcp resolves the
  //      workspace-scoped Supabase mirror via getBackend(workspaceId). After
  //      B1 both writers use getBackend, so the round-trip lands.
  const wowPath: string = firstWow.json.path;
  const wowText = "Tom prefers Discord over Telegram for notifications.";

  const { bearer: access_token } = await obtainBearer({
    baseUrl: BASE,
    email: testEmail,
    password: testPassword,
    testName: "first-wow-cross-flow",
  });
  check(
    "OAuth bearer obtained for same workspace via /authorize + /token",
    typeof access_token === "string" && access_token.length > 10,
    { tokenLen: access_token?.length ?? 0 },
  );

  const mcpRes = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${access_token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "garden_read", arguments: { path: wowPath } },
    }),
  });
  const mcpText = await mcpRes.text();
  let mcpJson: any = null;
  if (mcpText.startsWith("event:") || mcpText.includes("\ndata: ")) {
    const dataLine = mcpText
      .split("\n")
      .find((l) => l.startsWith("data: "))
      ?.slice("data: ".length);
    if (dataLine) mcpJson = JSON.parse(dataLine);
  } else {
    try {
      mcpJson = JSON.parse(mcpText);
    } catch {
      /* keep null */
    }
  }
  const mcpReadback: string = mcpJson?.result?.content?.[0]?.text ?? "";
  check(
    "/mcp garden_read on /api/first-wow's path returns the remembered text (B1 round-trip)",
    mcpRes.status === 200 &&
      mcpJson?.result?.isError !== true &&
      mcpReadback.includes(wowText),
    { mcpStatus: mcpRes.status, mcpJson, wowPath },
  );

  // 12. /api/persona/claudemd → text/markdown body
  const claudemd = await http("GET", "/api/persona/claudemd", jwt);
  check(
    "GET /api/persona/claudemd returns markdown body",
    claudemd.status === 200 &&
      claudemd.text.length > 100 &&
      claudemd.text.includes("CLAUDE"),
    { status: claudemd.status, len: claudemd.text.length },
  );

  // 13. /api/persona/index-stub → 7 universal sections + per-trait sections.
  // Each trait expands to multiple headers (founder → Meetings, Metrics,
  // Playbook; writer-researcher → Drafts, Published, Quotes). Persona at
  // this point is ["founder", "writer-researcher"] from step 6 above.
  const indexStub = await http("GET", "/api/persona/index-stub", jwt);
  const universalCount = [
    "Decisions",
    "Projects",
    "Daily",
    "Research",
    "References",
    "Ideas",
    "Inbox",
  ].filter((s) => indexStub.text.includes(`## ${s}`)).length;
  const founderHeaders = ["Meetings", "Metrics", "Playbook"].filter((s) =>
    indexStub.text.includes(`## ${s}`),
  ).length;
  const writerHeaders = ["Drafts", "Published", "Quotes"].filter((s) =>
    indexStub.text.includes(`## ${s}`),
  ).length;
  check(
    "GET /api/persona/index-stub returns 7 universal + 3 founder + 3 writer-researcher headers",
    indexStub.status === 200 &&
      universalCount === 7 &&
      founderHeaders === 3 &&
      writerHeaders === 3 &&
      indexStub.text.startsWith("<!--"),
    {
      status: indexStub.status,
      universalCount,
      founderHeaders,
      writerHeaders,
    },
  );

  // 14. /api/leave → nukes the cloud mirror end-to-end (T4.6)
  // Note: this comes near the END of the smoke because it deletes
  // tenant_keys — anything that needs the unwrapped DEK after this
  // point would fail. Order intentionally preserved.
  const leave = await http("POST", "/api/leave", jwt);
  check("POST /api/leave returns 200", leave.status === 200, leave.json);
  check(
    "POST /api/leave responds nuked:true",
    leave.json?.nuked === true,
    leave.json,
  );

  const { count: postNukeFiles } = await sb
    .from("vault_files")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);
  check("post-leave: vault_files rows = 0", (postNukeFiles ?? 0) === 0);

  const { count: postNukeKeys } = await sb
    .from("tenant_keys")
    .select("workspace_id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);
  check("post-leave: tenant_keys row = 0", (postNukeKeys ?? 0) === 0);

  const { count: postNukeAudit } = await sb
    .from("audit_log")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("operation", "vault_nuke");
  check(
    "post-leave: audit_log has a vault_nuke row",
    (postNukeAudit ?? 0) >= 1,
  );

  // Account survives — workspace + member rows stay
  const { count: postNukeWs } = await sb
    .from("workspaces")
    .select("id", { count: "exact", head: true })
    .eq("id", workspaceId);
  check("post-leave: workspaces row survives", (postNukeWs ?? 0) === 1);

  // Cleanup
  console.log("\nCleanup:");
  const wsDel = await sb.from("workspaces").delete().eq("id", workspaceId);
  console.log(`  workspaces delete: ${wsDel.error?.message ?? "ok"}`);
  const userDel = await sb.auth.admin.deleteUser(userId);
  console.log(`  user delete: ${userDel.error?.message ?? "ok"}`);

  // Print the path of any vault file the first-wow test created so the
  // operator can clean it up if the smoke ran against the real vault.
  if (firstWow.json?.path) {
    console.log(
      `  vault file (clean if smoke ran against real vault): ${firstWow.json.path}`,
    );
  }

  console.log(`\n${pass} pass / ${fail} fail`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
})();
