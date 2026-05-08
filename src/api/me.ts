import { Router } from "express";
import {
  requireOAuthAuth,
  requireOAuthWorkspace,
  asyncHandler,
  type AuthedWorkspaceRequest,
} from "./middleware.js";

/**
 * Trimmed to ONE field (security-audit H2, 2026-05-08). Stolen helper
 * bearer can no longer dump email + persona prose. Identity surface moved
 * to GET /api/dashboard/me (Supabase-JWT only).
 *
 * Helper-mac decoder at FirstRunCoordinator.swift:94 is
 * `MeBody { let workspace_name: String? }` — String? accepts this trim.
 */
export interface MeResponse {
  workspace_name: string;
}

export function meRouter(): Router {
  const router = Router();

  router.get(
    "/me",
    requireOAuthAuth,
    requireOAuthWorkspace,
    asyncHandler(async (req, res) => {
      const { membership } = req as AuthedWorkspaceRequest;
      const body: MeResponse = { workspace_name: membership.name };
      res.json(body);
    }),
  );

  return router;
}
