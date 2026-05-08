import { Router } from "express";
import {
  requireSupabaseAuth,
  requireWorkspace,
  asyncHandler,
  type AuthedWorkspaceRequest,
} from "./middleware.js";
import { respondError } from "./respond-error.js";
import {
  composePersonaClaudeMd,
  composePersonaSections,
} from "../tools/persona-claudemd.js";
import { mergeIntoExistingClaudeMd } from "../tools/claudemd-merge.js";
import { getBackend } from "../utils/backend-cache.js";
import { NotFoundError } from "../utils/storage.js";

export function personaRenderRouter(): Router {
  const router = Router();

  /**
   * POST /api/persona/render
   *
   * Idempotent. Reads workspace.settings.persona, composes a fresh CLAUDE.md,
   * and writes it to the vault (merge if existing, fresh if absent).
   *
   * Returns:
   *   { written: true,  path: "CLAUDE.md" }          — file created/updated
   *   { written: false, reason: "no_persona_set" }   — no persona in settings
   *   { written: false, reason: "no_change", path: "CLAUDE.md" } — idempotent
   */
  router.post(
    "/persona/render",
    requireSupabaseAuth,
    requireWorkspace,
    asyncHandler(async (req, res) => {
      const { membership } = req as AuthedWorkspaceRequest;
      const workspaceId = membership.workspaceId;
      const persona = membership.settings?.persona;

      if (!persona || (!persona.traits?.length && !persona.freetext?.trim())) {
        res.json({ written: false, reason: "no_persona_set" });
        return;
      }

      let backend;
      try {
        backend = await getBackend(workspaceId);
      } catch (err) {
        respondError(res, 500, "backend_unavailable", err, {
          logPrefix: "persona-render",
        });
        return;
      }

      const traits = persona.traits ?? [];
      const personaFreetext = persona.freetext ?? "";

      // Compose fresh CLAUDE.md sections
      const fresh = composePersonaClaudeMd({ traits, personaFreetext });

      // Read existing CLAUDE.md (null if absent)
      let existing: string | null = null;
      try {
        existing = await backend.readFile("CLAUDE.md");
      } catch (err) {
        if (!(err instanceof NotFoundError)) {
          respondError(res, 500, "claudemd_read_error", err, {
            logPrefix: "persona-render",
          });
          return;
        }
        existing = null;
      }

      let finalContent: string;
      if (existing === null) {
        finalContent = fresh;
      } else {
        const sections = composePersonaSections({ traits, personaFreetext });
        const { merged } = mergeIntoExistingClaudeMd(existing, sections);
        finalContent = merged;
      }

      // Idempotent: no write if content unchanged
      if (finalContent === existing) {
        res.json({ written: false, reason: "no_change", path: "CLAUDE.md" });
        return;
      }

      try {
        await backend.writeFile("CLAUDE.md", finalContent);
      } catch (err) {
        respondError(res, 500, "claudemd_write_error", err, {
          logPrefix: "persona-render",
        });
        return;
      }

      res.json({ written: true, path: "CLAUDE.md" });
    }),
  );

  return router;
}
