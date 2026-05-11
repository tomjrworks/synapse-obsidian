import { Router } from "express";
import { getBackend } from "../utils/backend-cache.js";
import { supabaseService } from "./supabase.js";
import {
  requireSupabaseAuth,
  requireWorkspace,
  workspaceLimitMiddleware,
  asyncHandler,
  type AuthedWorkspaceRequest,
} from "./middleware.js";
import { respondError } from "./respond-error.js";
import { patchWorkspaceSettings } from "./workspace.js";
import {
  classifyClaudeMdContent,
  composePersonaClaudeMd,
  composePersonaSections,
} from "../tools/persona-claudemd.js";
import { mergeIntoExistingClaudeMd } from "../tools/claudemd-merge.js";
import { scanFolders } from "../utils/folder-scan.js";

/**
 * F6 — onboarding rules-review step. Two endpoints:
 *
 *   GET  /api/onboarding/rules-preview
 *     Returns the persona-rendered CLAUDE.md the SITE shows the user
 *     for review/edit/skip. Composed from the observed folder structure
 *     (no longer trait-driven).
 *
 *   POST /api/onboarding/rules-review
 *     Body: { accept: true, edits?: string }   — write CLAUDE.md to vault
 *           { accept: false }                  — skip; no vault write
 *     Either way, advances workspace step from "rules-review" → "done".
 */
export function onboardingRulesRouter(): Router {
  const router = Router();

  router.get(
    "/onboarding/rules-preview",
    requireSupabaseAuth,
    requireWorkspace,
    workspaceLimitMiddleware(30),
    asyncHandler(async (req, res) => {
      const { membership } = req as AuthedWorkspaceRequest;
      const workspaceId = membership.workspaceId;

      const folderScan = await (async () => {
        try {
          const backend = await getBackend(workspaceId);
          return await scanFolders(backend);
        } catch {
          return [];
        }
      })();

      const claudeMd = composePersonaClaudeMd({ folderScan });
      res.json({
        markdown: claudeMd,
        existing_claude_md: await safeExists(workspaceId),
      });
    }),
  );

  router.post(
    "/onboarding/rules-review",
    requireSupabaseAuth,
    requireWorkspace,
    workspaceLimitMiddleware(10, 3600),
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as { accept?: unknown; edits?: unknown };
      if (typeof body.accept !== "boolean") {
        res.status(400).json({ error: "accept_required_boolean" });
        return;
      }
      const edits = typeof body.edits === "string" ? body.edits : undefined;
      const { membership } = req as AuthedWorkspaceRequest;

      const currentStep = membership.settings?.onboarding_step ?? "persona";
      if (currentStep !== "rules-review") {
        res.status(400).json({
          error: "invalid_step",
          reason: "not_at_rules_review_step",
          current: currentStep,
        });
        return;
      }

      if (body.accept) {
        try {
          await writeClaudeMdForWorkspace(membership.workspaceId, { edits });
        } catch (err) {
          respondError(res, 500, "vault_write_failed", err, {
            logPrefix: "rules-review",
          });
          return;
        }
      }

      const sb = supabaseService();
      const { settings, error } = await patchWorkspaceSettings(
        sb,
        membership.workspaceId,
        { onboarding_step: "done" },
      );
      if (error) {
        respondError(res, 500, "step_advance_failed", error, {
          logPrefix: "rules-review",
        });
        return;
      }

      res.json({
        accepted: body.accept,
        onboarding_step: settings.onboarding_step,
      });
    }),
  );

  return router;
}

async function safeExists(workspaceId: string): Promise<boolean> {
  try {
    const backend = await getBackend(workspaceId);
    return await backend.exists("CLAUDE.md");
  } catch {
    return false;
  }
}

interface WriteOpts {
  edits?: string;
}

async function writeClaudeMdForWorkspace(
  workspaceId: string,
  opts: WriteOpts,
): Promise<void> {
  const backend = await getBackend(workspaceId);

  // Edits (if provided) take precedence — the user reviewed and modified
  // the preview, so write what they signed off on.
  if (opts.edits != null) {
    await backend.writeFile("CLAUDE.md", opts.edits);
    return;
  }

  const folderScan = await scanFolders(backend).catch(() => []);
  const existing = (await backend.exists("CLAUDE.md"))
    ? await backend.readFile("CLAUDE.md")
    : null;
  const state = classifyClaudeMdContent(existing);

  // L5: never clobber a user-owned CLAUDE.md.
  if (state === "user_owned") return;

  if (state === "taproot_managed") {
    const sections = composePersonaSections({ folderScan });
    const { merged } = mergeIntoExistingClaudeMd(existing!, sections);
    await backend.writeFile("CLAUDE.md", merged);
    return;
  }

  const flat = composePersonaClaudeMd({ folderScan });
  await backend.writeFile("CLAUDE.md", flat);
}
