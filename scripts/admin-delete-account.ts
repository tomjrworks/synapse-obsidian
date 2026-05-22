/**
 * ADMIN: delete a user account by email — one-off operational tool.
 *
 * Replicates the DELETE /api/account cascade (src/api/account.ts:40-145)
 * verbatim but driven by email lookup against auth.users instead of an
 * authenticated request. Service-role only. NOT for routine use.
 *
 * Run:
 *   pnpm tsx scripts/admin-delete-account.ts <email>
 *
 * Cascade order (FK-locked) — DO NOT REORDER:
 *   1. auth.admin.listUsers → find user by email
 *   2. SELECT workspaces WHERE owner_user_id = user.id
 *   3. For each workspace:
 *        a. cancelWorkspaceSubscription (fail-closed)
 *        b. nukeWorkspace (writes vault_nuke audit row)
 *        c. audit_log insert (account_delete)
 *        d. DELETE FROM workspaces (cascades child tables)
 *   4. auth.admin.deleteUser
 */
import { createClient } from "@supabase/supabase-js";
import { nukeWorkspace } from "../src/utils/supabase-mirror.js";
import { cancelWorkspaceSubscription } from "../src/utils/stripe-cancel.js";
import { getSubscription } from "../src/api/subscription.js";

const email = process.argv[2];
if (!email) {
  console.error("usage: pnpm tsx scripts/admin-delete-account.ts <email>");
  process.exit(2);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  process.exit(2);
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// 1) Find user.
//    auth.admin.listUsers has no email filter, so we page until we find them
//    or run out. For prod-scale this would be wasteful, but the account count
//    is small enough (and this script is a one-off operator tool).
async function findUserIdByEmail(target: string): Promise<string | null> {
  let page = 1;
  while (true) {
    const { data, error } = await sb.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) throw error;
    const match = data.users.find(
      (u) => u.email?.toLowerCase() === target.toLowerCase(),
    );
    if (match) return match.id;
    if (data.users.length < 200) return null;
    page += 1;
  }
}

console.log(`[admin-delete] looking up user by email: ${email}`);
const userId = await findUserIdByEmail(email);
if (!userId) {
  console.error(`[admin-delete] no user found for email ${email}`);
  process.exit(1);
}
console.log(`[admin-delete] user_id=${userId}`);

// 2) Find owned workspaces.
const { data: ownedRows, error: lookupErr } = await sb
  .from("workspaces")
  .select("id, name, settings")
  .eq("owner_user_id", userId);
if (lookupErr) {
  console.error(
    `[admin-delete] workspaces lookup failed: ${lookupErr.message}`,
  );
  process.exit(1);
}
const ownedWorkspaceIds = (ownedRows ?? []).map((r) => r.id as string);
console.log(
  `[admin-delete] owned workspaces: ${ownedWorkspaceIds.length}`,
  ownedRows,
);

// 3) Cascade per workspace.
for (const workspaceId of ownedWorkspaceIds) {
  console.log(`[admin-delete] workspace ${workspaceId} — starting cascade`);

  // Stripe cancel: SITE endpoint fails-closed on this, but the admin tool
  // should never block local cleanup over a missing STRIPE_SECRET_KEY. Log
  // the subscription id loudly so the operator can manually cancel via the
  // Stripe Dashboard if the API call below didn't fire.
  const subRow = await getSubscription(sb, workspaceId);
  if (subRow?.stripe_subscription_id) {
    console.log(
      `[admin-delete]   stripe subscription id (manual cancel if needed): ${subRow.stripe_subscription_id} (status=${subRow.status})`,
    );
  }
  try {
    const cancelResult = await cancelWorkspaceSubscription(sb, workspaceId);
    console.log(
      `[admin-delete]   stripe cancel: ${cancelResult.canceled ? "canceled" : "skipped"} (${cancelResult.reason})`,
    );
  } catch (err) {
    console.warn(
      `[admin-delete]   stripe cancel FAILED (continuing): ${(err as Error).message}`,
    );
    console.warn(
      `[admin-delete]   IF SUB EXISTS, cancel via Stripe Dashboard using the id above`,
    );
  }

  const nukeResult = await nukeWorkspace(sb, workspaceId, userId, {
    ip: undefined,
    userAgent: "admin-delete-account-script",
  });
  console.log(
    `[admin-delete]   nuke: object_count=${nukeResult.object_count} file_rows=${nukeResult.file_row_count}`,
  );

  const { error: auditErr } = await sb.from("audit_log").insert({
    workspace_id: workspaceId,
    user_id: userId,
    operation: "account_delete",
    details: {
      workspaces_purged_count: ownedWorkspaceIds.length,
      via: "admin-delete-account-script",
    },
    ip: null,
    user_agent: "admin-delete-account-script",
  });
  if (auditErr) {
    console.error(
      `[admin-delete]   audit_log write failed: ${auditErr.message} (continuing)`,
    );
  }

  const { error: wsDelErr } = await sb
    .from("workspaces")
    .delete()
    .eq("id", workspaceId);
  if (wsDelErr) {
    console.error(
      `[admin-delete]   workspace delete failed: ${wsDelErr.message}`,
    );
    process.exit(1);
  }
  console.log(`[admin-delete]   workspace row deleted`);
}

// 4) Delete auth user.
const { error: authDelErr } = await sb.auth.admin.deleteUser(userId);
if (authDelErr) {
  console.error(
    `[admin-delete] auth user delete failed: ${authDelErr.message}`,
  );
  process.exit(1);
}
console.log(`[admin-delete] auth user deleted — email ${email} is now free`);
console.log(`[admin-delete] DONE`);
