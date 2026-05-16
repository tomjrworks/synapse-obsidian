import { Router } from "express";
import {
  requireSupabaseAuth,
  requireWorkspace,
  workspaceLimitMiddleware,
  asyncHandler,
  type AuthedWorkspaceRequest,
} from "./middleware.js";

/**
 * Dashboard-only identity surface. Authenticated via Supabase JWT —
 * NOT the OAuth bearer the helper-mac uses. Bearer compromise does not
 * reach this endpoint because helper bearers are not Supabase JWTs.
 */
export interface DashboardMeResponse {
  user_id: string;
  email?: string;
  workspace_id: string;
  workspace_name: string;
  onboarding_step: string | null;
  persona_traits: string[];
  persona_freetext: string | null;
  connected_clients: string[];
}

export function dashboardRouter(): Router {
  const router = Router();

  router.get(
    "/dashboard/me",
    requireSupabaseAuth,
    requireWorkspace,
    workspaceLimitMiddleware(30),
    asyncHandler(async (req, res) => {
      const { user, membership } = req as AuthedWorkspaceRequest;
      const settings = membership.settings;
      const persona = settings.persona ?? {};

      const body: DashboardMeResponse = {
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
      };
      res.json(body);
    }),
  );

  return router;
}
