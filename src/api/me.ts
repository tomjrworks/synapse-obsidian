import { Router } from "express";
import {
  requireSupabaseAuth,
  requireWorkspace,
  asyncHandler,
  type AuthedWorkspaceRequest,
} from "./middleware.js";

/**
 * Wire shape returned by `GET /api/me`. Mirrors the helper-mac
 * `MeBody` decoder at AppDelegate.swift:250 (which only consumes
 * `workspace_name` today, but the rest of the surface is part of
 * the contract for the cloud signin handshake + future helpers).
 */
export interface MeResponse {
  user_id: string;
  email?: string;
  workspace_id: string;
  workspace_name: string;
  onboarding_step: string | null;
  persona_traits: string[];
  persona_freetext: string | null;
  connected_clients: string[];
}

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

      const body: MeResponse = {
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
