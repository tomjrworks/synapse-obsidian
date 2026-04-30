import { Router } from "express";
import {
  requireSupabaseAuth,
  requireWorkspace,
  asyncHandler,
  type AuthedWorkspaceRequest,
} from "./middleware.js";

export function meRouter(): Router {
  const router = Router();

  router.get(
    "/me",
    requireSupabaseAuth,
    requireWorkspace,
    asyncHandler(async (req, res) => {
      const { user, membership } = req as AuthedWorkspaceRequest;
      const settings = membership.settings;
      const persona = settings.persona ?? {};

      res.json({
        user_id: user.id,
        email: user.email,
        workspace_id: membership.workspaceId,
        workspace_name: membership.name,
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
