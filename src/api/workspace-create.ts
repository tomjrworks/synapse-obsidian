import { randomUUID } from "node:crypto";
import { Router } from "express";
import { supabaseService } from "./supabase.js";
import { generateDek, wrapDek } from "./crypto.js";
import {
  requireSupabaseAuth,
  userIdLimitMiddleware,
  asyncHandler,
  type AuthedRequest,
} from "./middleware.js";
import { getMembershipForUser } from "./workspace.js";
import { respondError } from "./respond-error.js";

export function workspaceCreateRouter(): Router {
  const router = Router();

  // POST /api/workspace — idempotent workspace bootstrap for Supabase-authed users.
  // Called from the SITE auth callback immediately after email confirmation so that
  // every onboarding API call that requires requireWorkspace finds a workspace.
  router.post(
    "/workspace",
    requireSupabaseAuth,
    userIdLimitMiddleware(3, 3600), // 3/hour/user — keyed by user.id (workspace doesn't exist yet)
    asyncHandler(async (req, res) => {
      const { user } = req as AuthedRequest;
      const sb = supabaseService();

      const existing = await getMembershipForUser(sb, user.id);
      if (existing) {
        res.json({ workspace_id: existing.workspaceId });
        return;
      }

      const wsName = user.email
        ? `${user.email.split("@")[0]}'s garden`
        : "my garden";

      const workspaceId = randomUUID();
      const dek = generateDek();
      const wrapped = wrapDek(dek, workspaceId);
      const wrappedDekParam = `\\x${wrapped.toString("hex")}`;

      const { error: rpcError } = await sb.rpc(
        "create_workspace_for_new_user",
        {
          p_workspace_id: workspaceId,
          p_user_id: user.id,
          p_workspace_name: wsName,
          p_wrapped_dek: wrappedDekParam,
        },
      );

      if (rpcError) {
        console.error(
          `[workspace] create_workspace_for_new_user failed: ${rpcError.message}`,
        );
        respondError(res, 500, "workspace_create_failed", rpcError, {
          logPrefix: "workspace",
        });
        return;
      }

      res.status(201).json({ workspace_id: workspaceId });
    }),
  );

  return router;
}
