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
  classifyClaudeMdContent,
  composePersonaClaudeMd,
  composePersonaSections,
} from "../tools/persona-claudemd.js";
import { mergeIntoExistingClaudeMd } from "../tools/claudemd-merge.js";
import { getBackend } from "../utils/backend-cache.js";
import { NotFoundError } from "../utils/storage.js";
import { scanFolders } from "../utils/folder-scan.js";

export function personaRenderRouter(): Router {
  const router = Router();

  /**
   * POST /api/persona/render
   *
   * Idempotent. Composes a fresh CLAUDE.md from the observed folder
   * structure (no longer trait-driven) and writes it according to the
   * three-state classifier (L5):
   *   - fresh           → write full scaffold
   *   - taproot_managed → merge managed blocks, preserve outside edits
   *   - user_owned      → skip silently
   *
   * Returns:
   *   { written: true,  path: "CLAUDE.md", claudemd_status: "written" | "merged" }
   *   { written: false, reason: "no_change", claudemd_status: "merged" }
   *   { written: false, reason: "skipped_user_owned", claudemd_status: "skipped_user_owned" }
   */
  router.post(
    "/persona/render",
    requireSupabaseAuth,
    requireWorkspace,
    workspaceLimitMiddleware(10, 3600),
    asyncHandler(async (req, res) => {
      const { membership } = req as AuthedWorkspaceRequest;
      const workspaceId = membership.workspaceId;

      let backend;
      try {
        backend = await getBackend(workspaceId);
      } catch (err) {
        respondError(res, 500, "backend_unavailable", err, {
          logPrefix: "persona-render",
        });
        return;
      }

      const folderScan = await scanFolders(backend).catch(() => []);

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

      const state = classifyClaudeMdContent(existing);

      if (state === "user_owned") {
        res.json({
          written: false,
          reason: "skipped_user_owned",
          claudemd_status: "skipped_user_owned",
          path: "CLAUDE.md",
        });
        return;
      }

      let finalContent: string;
      let claudemdStatus: "written" | "merged";

      if (state === "fresh") {
        finalContent = composePersonaClaudeMd({ folderScan });
        claudemdStatus = "written";
      } else {
        // taproot_managed: merge fresh sections into the existing file.
        const sections = composePersonaSections({ folderScan });
        const { merged } = mergeIntoExistingClaudeMd(existing!, sections);
        finalContent = merged;
        claudemdStatus = "merged";
      }

      if (finalContent === existing) {
        res.json({
          written: false,
          reason: "no_change",
          claudemd_status: claudemdStatus,
          path: "CLAUDE.md",
        });
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

      res.json({
        written: true,
        path: "CLAUDE.md",
        claudemd_status: claudemdStatus,
      });
    }),
  );

  return router;
}
