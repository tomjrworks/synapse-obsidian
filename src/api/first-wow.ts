import { Router } from "express";
import type { StorageBackend } from "../utils/storage.js";
import { nukeWorkspace } from "../utils/supabase-mirror.js";
import { supabaseService } from "./supabase.js";
import {
  requireSupabaseAuth,
  asyncHandler,
  type AuthedRequest,
} from "./middleware.js";
import { getMembershipForUser } from "./workspace.js";

export function firstWowRouter(backend: StorageBackend): Router {
  const router = Router();

  router.post(
    "/first-wow",
    requireSupabaseAuth,
    asyncHandler(async (req, res) => {
      const { remembered_text } = (req.body ?? {}) as {
        remembered_text?: unknown;
      };
      if (typeof remembered_text !== "string" || !remembered_text.trim()) {
        res.status(400).json({ error: "remembered_text_required" });
        return;
      }

      const sb = supabaseService();
      const userId = (req as AuthedRequest).user.id;
      const membership = await getMembershipForUser(sb, userId);
      if (!membership) {
        res.status(404).json({ error: "no_workspace" });
        return;
      }

      const trimmed = remembered_text.trim();
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const path = `inbox/first-wow-${ts}.md`;
      const body = `${trimmed}\n`;

      // Stage 1: writes to whichever backend the server was started with.
      // T6 will swap in a workspace-scoped backend resolved from the JWT.
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
    asyncHandler(async (req, res) => {
      const sb = supabaseService();
      const userId = (req as AuthedRequest).user.id;
      const membership = await getMembershipForUser(sb, userId);
      if (!membership) {
        res.status(404).json({ error: "no_workspace" });
        return;
      }

      // Stage 1 has no team flow yet — every workspace has exactly one
      // member who is the owner. Stage 2 will need an owner-only gate
      // here (members of a teamed workspace shouldn't be able to nuke
      // someone else's mirror). Tracked under T2 follow-ups.

      try {
        const result = await nukeWorkspace(sb, membership.workspaceId, userId);
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
