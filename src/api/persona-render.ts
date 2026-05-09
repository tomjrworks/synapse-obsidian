import { Router } from "express";
import {
  requireSupabaseAuth,
  requireWorkspace,
  workspaceLimitMiddleware,
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
import { listVaultFiles } from "../utils/vault.js";

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
    workspaceLimitMiddleware(10, 3600), // 10/hour/workspace — LLM write; abuse cap
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

      // Detect vault maturity to emit context-aware CLAUDE.md
      const allFiles = await listVaultFiles(backend).catch(
        () => [] as string[],
      );
      const totalFiles = allFiles.length;
      const topFolderSet = new Set<string>();
      for (const f of allFiles) {
        const slash = f.indexOf("/");
        if (slash > 0) topFolderSet.add(f.slice(0, slash));
      }
      const vaultMaturity: "fresh" | "mature" =
        totalFiles > 50 ? "mature" : "fresh";
      const actualTopFolders = [...topFolderSet].sort().slice(0, 20);

      // Compose fresh CLAUDE.md sections
      const fresh = composePersonaClaudeMd({
        traits,
        personaFreetext,
        vaultMaturity,
        actualTopFolders,
      });

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
        const sections = composePersonaSections({
          traits,
          personaFreetext,
          vaultMaturity,
          actualTopFolders,
        });
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
