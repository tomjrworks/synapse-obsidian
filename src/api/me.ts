import { Router } from "express";
import { supabaseService } from "./supabase.js";
import {
  requireSupabaseAuth,
  asyncHandler,
  type AuthedRequest,
} from "./middleware.js";
import { getMembershipForUser } from "./workspace.js";

export function meRouter(): Router {
  const router = Router();

  router.get(
    "/me",
    requireSupabaseAuth,
    asyncHandler(async (req, res) => {
      const authed = req as AuthedRequest;
      const sb = supabaseService();
      const membership = await getMembershipForUser(sb, authed.user.id);
      if (!membership) {
        res.status(404).json({ error: "no_workspace" });
        return;
      }

      const settings = membership.settings;
      const persona = settings.persona ?? {};

      res.json({
        user_id: authed.user.id,
        email: authed.user.email,
        workspace_id: membership.workspaceId,
        onboarding_step: settings.onboarding_step ?? null,
        persona_traits: Array.isArray(persona.traits) ? persona.traits : [],
        persona_freetext:
          typeof persona.freetext === "string" ? persona.freetext : null,
        connected_clients: Array.isArray(settings.connected_clients)
          ? settings.connected_clients
          : [],
      });
    }),
  );

  return router;
}
