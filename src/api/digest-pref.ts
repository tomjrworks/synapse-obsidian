import { Router } from "express";
import { supabaseService } from "./supabase.js";
import {
  requireSupabaseAuth,
  requireWorkspace,
  workspaceLimitMiddleware,
  asyncHandler,
  type AuthedWorkspaceRequest,
} from "./middleware.js";
import { respondError } from "./respond-error.js";

// PR #5 (S74) — Digest preference read/write surface for the SITE
// dashboard's DigestToggle. Before this, the toggle was pure local React
// state — user opted out, still got the Sunday digest email. CAN-SPAM hit.
//
// The digest_preferences row is created at workspace insert via the
// `trg_workspace_digest_preferences` trigger in 0016_digest_preferences.sql,
// so this surface never needs to upsert — it only updates an existing row.
export function digestPrefRouter(): Router {
  const router = Router();

  router.get(
    "/dashboard/digest-pref",
    requireSupabaseAuth,
    requireWorkspace,
    workspaceLimitMiddleware(20, 3600),
    asyncHandler(async (req, res) => {
      const { membership } = req as AuthedWorkspaceRequest;
      const sb = supabaseService();
      const { data, error } = await sb
        .from("digest_preferences")
        .select("email_subscribed")
        .eq("workspace_id", membership.workspaceId)
        .maybeSingle();
      if (error) {
        respondError(res, 500, "digest_pref_read_failed", error, {
          logPrefix: "digest-pref",
        });
        return;
      }
      // Default to true if the row is missing — matches the schema default
      // and the trigger-created baseline. A missing row should never happen
      // post-trigger, but the safety net keeps the GET honest.
      res.json({ email_subscribed: data?.email_subscribed ?? true });
    }),
  );

  router.post(
    "/dashboard/digest-pref",
    requireSupabaseAuth,
    requireWorkspace,
    workspaceLimitMiddleware(20, 3600),
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as { email_subscribed?: unknown };
      // Strict boolean — reject "no", 0, "false", null, undefined.
      if (typeof body.email_subscribed !== "boolean") {
        respondError(
          res,
          400,
          "invalid_body",
          new Error("email_subscribed must be a boolean"),
          { logPrefix: "digest-pref" },
        );
        return;
      }
      const { membership } = req as AuthedWorkspaceRequest;
      const sb = supabaseService();
      const { error } = await sb
        .from("digest_preferences")
        .update({
          email_subscribed: body.email_subscribed,
          updated_at: new Date().toISOString(),
        })
        .eq("workspace_id", membership.workspaceId);
      if (error) {
        respondError(res, 500, "digest_pref_write_failed", error, {
          logPrefix: "digest-pref",
        });
        return;
      }
      res.json({ email_subscribed: body.email_subscribed });
    }),
  );

  return router;
}
