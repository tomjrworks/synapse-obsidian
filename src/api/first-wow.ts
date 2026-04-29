import { Router } from "express";
import { nukeWorkspace } from "../utils/supabase-mirror.js";
import { getBackend } from "../utils/backend-cache.js";
import { supabaseService } from "./supabase.js";
import {
  requireSupabaseAuth,
  requireWorkspace,
  asyncHandler,
  type AuthedWorkspaceRequest,
} from "./middleware.js";

export function firstWowRouter(): Router {
  const router = Router();

  router.post(
    "/first-wow",
    requireSupabaseAuth,
    requireWorkspace,
    asyncHandler(async (req, res) => {
      const { remembered_text } = (req.body ?? {}) as {
        remembered_text?: unknown;
      };
      if (typeof remembered_text !== "string" || !remembered_text.trim()) {
        res.status(400).json({ error: "remembered_text_required" });
        return;
      }

      const trimmed = remembered_text.trim();
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const path = `inbox/first-wow-${ts}.md`;
      const body = `${trimmed}\n`;

      const { membership } = req as AuthedWorkspaceRequest;
      const backend = await getBackend(membership.workspaceId);

      try {
        await backend.writeFile(path, body);
      } catch (err: any) {
        res
          .status(500)
          .json({ error: "vault_write_failed", detail: err.message });
        return;
      }

      let verified = false;
      try {
        const readback = await backend.readFile(path);
        verified = readback.includes(trimmed);
      } catch {
        verified = false;
      }

      res.json({
        status: verified ? "verified" : "pending",
        path,
      });
    }),
  );

  // "Leave Taproot" — deletes the cloud mirror only. Local files stay
  // (helper-managed). Workspace row + memberships survive so the user can
  // re-onboard. Full account delete is a separate Stage 2+ button.
  router.post(
    "/leave",
    requireSupabaseAuth,
    requireWorkspace,
    asyncHandler(async (req, res) => {
      const { user, membership } = req as AuthedWorkspaceRequest;
      const sb = supabaseService();

      // Stage 1 has no team flow yet — every workspace has exactly one
      // member who is the owner. Stage 2 will need an owner-only gate
      // here (members of a teamed workspace shouldn't be able to nuke
      // someone else's mirror). Tracked under T2 follow-ups.

      try {
        const result = await nukeWorkspace(sb, membership.workspaceId, user.id);
        res.json({
          nuked: true,
          object_count: result.objectCount,
          file_row_count: result.fileRowCount,
        });
      } catch (err: any) {
        res.status(500).json({
          error: "nuke_failed",
          detail: err?.message ?? String(err),
        });
      }
    }),
  );

  return router;
}
