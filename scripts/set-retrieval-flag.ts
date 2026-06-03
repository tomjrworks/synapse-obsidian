/**
 * ADMIN: flip the per-workspace Pass 3 retrieval V2 flag (Option B of
 * decision 2026-06-03-pass-3-cohort-flag-rollout).
 *
 * Sets workspaces.settings.retrieval_v2 = true|false for ONE workspace — the
 * no-redeploy cohort flip. Read-merge-write so other settings keys
 * (onboarding_step, persona, connected_clients) are preserved.
 *
 * The running server caches this for ≤5 min (workspace-flags.ts), so a flip
 * propagates within that window; no restart needed.
 *
 * Service-role only. Run:
 *   pnpm tsx scripts/set-retrieval-flag.ts <workspace_id> on|off
 *
 * PRE-FLIP GATE (do this before turning a workspace ON): drain its token column
 *   select count(*) from vault_files where workspace_id = '<ws>' and extracted_tokens is null;
 * must be ~0 (kick a no-op write / query first to warm the backfill). Turning a
 * workspace ON before the drain just yields fewer hits until it catches up — not
 * wrong results — but draining first keeps the flip clean. OFF is instant + safe.
 */
import { createClient } from "@supabase/supabase-js";

const workspaceId = process.argv[2];
const state = process.argv[3];

function usage(msg: string): never {
  console.error(msg);
  console.error(
    "usage: pnpm tsx scripts/set-retrieval-flag.ts <workspace_id> on|off",
  );
  process.exit(2);
}

if (!workspaceId) usage("missing <workspace_id>");
if (state !== "on" && state !== "off") usage(`bad state: ${state ?? "(none)"}`);
const enabled = state === "on";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  process.exit(2);
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Read-merge-write (mirrors patchWorkspaceSettings) so we never clobber sibling
// settings keys.
const { data: row, error: readErr } = await sb
  .from("workspaces")
  .select("name, settings")
  .eq("id", workspaceId)
  .maybeSingle();

if (readErr) {
  console.error(`[set-retrieval-flag] read failed: ${readErr.message}`);
  process.exit(1);
}
if (!row) {
  console.error(`[set-retrieval-flag] no workspace found: ${workspaceId}`);
  process.exit(1);
}

const current = (row.settings ?? {}) as Record<string, unknown>;
const prior = current.retrieval_v2 === true;
const merged = { ...current, retrieval_v2: enabled };

const { error: writeErr } = await sb
  .from("workspaces")
  .update({ settings: merged })
  .eq("id", workspaceId);

if (writeErr) {
  console.error(`[set-retrieval-flag] write failed: ${writeErr.message}`);
  process.exit(1);
}

console.log(
  `[set-retrieval-flag] ${row.name ?? "(unnamed)"} (${workspaceId}): retrieval_v2 ${prior} → ${enabled}`,
);
console.log(
  "[set-retrieval-flag] propagates to the running server within ≤5 min (settings cache TTL).",
);
process.exit(0);
