import { Router } from "express";
import type { StorageBackend } from "../utils/storage.js";
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

  router.post(
    "/leave",
    requireSupabaseAuth,
    asyncHandler(async (_req, res) => {
      res.status(501).json({
        error: "not_implemented",
        detail: "Workspace deletion ships in Stage 3.",
      });
    }),
  );

  return router;
}
