import { Router } from "express";
import { nukeWorkspace } from "../utils/supabase-mirror.js";
import { evict } from "../utils/backend-cache.js";
import { cancelWorkspaceSubscription } from "../utils/stripe-cancel.js";
import { supabaseService } from "./supabase.js";
import {
  requireSupabaseAuth,
  requireWorkspace,
  userIdLimitMiddleware,
  asyncHandler,
  type AuthedRequest,
} from "./middleware.js";
import { respondError } from "./respond-error.js";

// PR #5 (S04) — DELETE /api/account. Full account erasure, GDPR / right-to-
// erasure self-serve path. The SITE-side `DeleteAccountDialog` requires the
// user to type "delete my account" before this endpoint is called; no API-
// side token, the endpoint trusts authenticated owner-self-call.
//
// Cascade order (FK-locked by workspaces.owner_user_id ON DELETE RESTRICT
// in 0002_workspaces.sql) — DO NOT REORDER:
//
//   1. Find all workspaces.owner_user_id = user.id
//   2. For each workspace, in this order:
//      a. cancel Stripe sub (fail-closed: 500 + no further work if Stripe errs)
//      b. nukeWorkspace (writes vault_nuke audit row WHILE workspace exists)
//      c. emit account_delete audit row
//      d. DELETE FROM workspaces WHERE id = ? (cascades all child tables)
//      e. evict backend cache
//   3. supabaseService().auth.admin.deleteUser(user.id) — only after every
//      workspace row is gone. If this step fails, workspaces are already gone
//      and the user-shell may persist — surface 500 with a diagnostic so an
//      operator can clean up manually.
//
// Multi-workspace iteration: Stage 1 is one-workspace-per-user, but the loop
// guards against future drift (teams, multiple personal workspaces).
export function accountRouter(): Router {
  const router = Router();

  router.delete(
    "/account",
    requireSupabaseAuth,
    requireWorkspace,
    // userIdLimitMiddleware (not workspaceLimitMiddleware) — workspaces are
    // about to be deleted, so workspace-keyed limiting would lose the key
    // mid-request. User-ID keying is durable across the cascade.
    userIdLimitMiddleware(3, 3600), // 3/hour/user — destructive, low cap
    asyncHandler(async (req, res) => {
      const { user } = req as AuthedRequest;
      const sb = supabaseService();

      const { data: ownedRows, error: lookupErr } = await sb
        .from("workspaces")
        .select("id")
        .eq("owner_user_id", user.id);
      if (lookupErr) {
        respondError(res, 500, "workspaces_lookup_failed", lookupErr, {
          logPrefix: "account-delete",
        });
        return;
      }
      const ownedWorkspaceIds = (ownedRows ?? []).map((r) => r.id as string);

      // No workspaces → still delete the auth user (account-only cleanup).
      let workspacesPurged = 0;

      for (const workspaceId of ownedWorkspaceIds) {
        try {
          await cancelWorkspaceSubscription(sb, workspaceId);
        } catch (err) {
          respondError(res, 500, "stripe_cancel_failed", err, {
            logPrefix: "account-delete",
          });
          return;
        }

        try {
          await nukeWorkspace(sb, workspaceId, user.id, {
            ip: req.ip,
            userAgent: req.headers["user-agent"],
          });
        } catch (err) {
          respondError(res, 500, "nuke_failed", err, {
            logPrefix: "account-delete",
          });
          return;
        }

        // account_delete audit row — written WHILE the workspace still exists,
        // same posture as vault_nuke. audit_log.workspace_id will cascade out
        // when the workspace row goes, so this is more of a server-side log
        // than a permanent record — but it captures intent at the moment of
        // deletion for incident triage if anything downstream fails.
        const { error: auditErr } = await sb.from("audit_log").insert({
          workspace_id: workspaceId,
          user_id: user.id,
          operation: "account_delete",
          details: { workspaces_purged_count: ownedWorkspaceIds.length },
          ip: req.ip ?? null,
          user_agent: req.headers["user-agent"] ?? null,
        });
        if (auditErr) {
          console.error(
            `[account-delete] audit_log write failed for workspace ${workspaceId}: ${auditErr.message}`,
          );
        }

        const { error: wsDelErr } = await sb
          .from("workspaces")
          .delete()
          .eq("id", workspaceId);
        if (wsDelErr) {
          respondError(res, 500, "workspace_delete_failed", wsDelErr, {
            logPrefix: "account-delete",
          });
          return;
        }

        evict(workspaceId);
        workspacesPurged += 1;
      }

      const { error: authDelErr } = await sb.auth.admin.deleteUser(user.id);
      if (authDelErr) {
        // Workspaces already gone — user-shell may persist. Log loudly for
        // operator cleanup; surface 500 so the SITE knows something went
        // wrong (user will still be effectively locked out: no workspace,
        // no sub, no vault).
        respondError(res, 500, "auth_user_delete_failed", authDelErr, {
          logPrefix: "account-delete",
          extra: { workspaces_purged: workspacesPurged },
        });
        return;
      }

      res.json({ deleted: true, workspaces_purged: workspacesPurged });
    }),
  );

  return router;
}
