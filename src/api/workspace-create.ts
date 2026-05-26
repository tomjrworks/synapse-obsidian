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
    // 60/hour/user. The endpoint is idempotent (returns existing workspace_id
    // on subsequent calls) — but SITE's onboarding/layout.tsx fires this on
    // EVERY page render to ensure the workspace exists. A normal wizard walk
    // can fire 7-12+ workspace POSTs across step navigations, refreshes, and
    // back-button presses. The old 3/hour cap triggered a server-side redirect
    // loop (429 → /sign-in?error → middleware → /dashboard → /onboarding/X →
    // /api/workspace → 429 → ...) that the browser killed with
    // TOO_MANY_REDIRECTS. Tom hit this during a fresh-user smoke walk
    // 2026-05-11 22:40 UTC at the rules-review step. 60/hour is comfortably
    // above realistic legitimate usage and still abuse-resistant.
    userIdLimitMiddleware(60, 3600),
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

      const signupWebhookUrl = process.env.DISCORD_SIGNUPS_WEBHOOK_URL;
      if (signupWebhookUrl) {
        // S64 originally masked the local-part of the email here because
        // Discord channels weren't classified as PII storage. Unmasked
        // 2026-05-26 because operator outreach to new signups needs the
        // full email and #taproot-signups is an invite-only solo-operator
        // channel. KEEP THAT CHANNEL PRIVATE — adding teammates or
        // contractors to it re-opens the S64 finding.
        const signupEmail = user.email ?? "unknown";
        fetch(signupWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `🌱 New signup | ${signupEmail} | workspace=${workspaceId}`,
          }),
        }).catch(() => {});
      }
    }),
  );

  return router;
}
