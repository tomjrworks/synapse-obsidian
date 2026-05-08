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
  composePersonaClaudeMd,
  isTraitId,
} from "../tools/persona-claudemd.js";
import { mergeIntoExistingClaudeMd } from "../tools/claudemd-merge.js";
import { composePersonaSections } from "../tools/persona-claudemd.js";

/**
 * F6 — onboarding rules-review step. Two endpoints:
 *
 *   GET  /api/onboarding/rules-preview
 *     Returns the persona-rendered CLAUDE.md the SITE shows the user
 *     for review/edit/skip. 404 when persona is not yet set (the SITE
 *     shouldn't reach this step in that case, but the guard makes the
 *     404 explicit instead of returning a misleading default).
 *
 *   POST /api/onboarding/rules-review
 *     Body: { accept: true, edits?: string }   — write CLAUDE.md to vault
 *           { accept: false }                  — skip; no vault write
 *     Either way, advances workspace step from "rules-review" → "done".
 *
 * Mounted via mountApiRoutes; lives outside personaRouter because the
 * preview endpoint reuses the persona renderer but the accept endpoint
 * has different auth + side-effect semantics (writes to vault).
 */
export function onboardingRulesRouter(): Router {
  const router = Router();

  router.get(
    "/onboarding/rules-preview",
    requireSupabaseAuth,
    requireWorkspace,
    workspaceLimitMiddleware(30), // 30/min/workspace — read-only preview, generous cap
    asyncHandler(async (req, res) => {
      const { membership } = req as AuthedWorkspaceRequest;
      const persona = membership.settings.persona ?? {};
      const traits: string[] = Array.isArray(persona.traits)
        ? persona.traits.filter(
            (t: unknown): t is string => typeof t === "string" && isTraitId(t),
          )
        : [];
      const freetext =
        typeof persona.freetext === "string" ? persona.freetext.trim() : "";

      if (traits.length === 0 && !freetext) {
        res
          .status(404)
          .json({ error: "persona_not_set", message: "Set persona first." });
        return;
      }

      const claudeMd = composePersonaClaudeMd({
        traits,
        personaFreetext: freetext || undefined,
      });
      res.json({
        markdown: claudeMd,
        // exists tells the SITE whether the user already has a CLAUDE.md
        // in their vault — flips the page header copy ("review" vs
        // "we'll merge your edits with the existing CLAUDE.md").
        existing_claude_md: await safeExists(membership.workspaceId),
      });
    }),
  );

  router.post(
    "/onboarding/rules-review",
    requireSupabaseAuth,
    requireWorkspace,
    workspaceLimitMiddleware(10, 3600), // 10/hour/workspace — vault write + step advance
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as { accept?: unknown; edits?: unknown };
      if (typeof body.accept !== "boolean") {
        res.status(400).json({ error: "accept_required_boolean" });
        return;
      }
      const edits = typeof body.edits === "string" ? body.edits : undefined;
      const { membership } = req as AuthedWorkspaceRequest;

      // Precondition: workspace must be at the rules-review step.
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
          await writeClaudeMdForWorkspace(membership.workspaceId, {
            traits: extractTraits(membership.settings.persona),
            freetext: extractFreetext(membership.settings.persona),
            edits,
          });
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

function extractTraits(persona: unknown): string[] {
  if (!persona || typeof persona !== "object") return [];
  const traits = (persona as { traits?: unknown }).traits;
  if (!Array.isArray(traits)) return [];
  return traits.filter(
    (t): t is string => typeof t === "string" && isTraitId(t),
  );
}

function extractFreetext(persona: unknown): string | undefined {
  if (!persona || typeof persona !== "object") return undefined;
  const ft = (persona as { freetext?: unknown }).freetext;
  return typeof ft === "string" && ft.trim() ? ft.trim() : undefined;
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
  traits: string[];
  freetext?: string;
  edits?: string;
}

async function writeClaudeMdForWorkspace(
  workspaceId: string,
  opts: WriteOpts,
): Promise<void> {
  const backend = await getBackend(workspaceId);

  // Edits (if provided) take precedence — the user reviewed and modified
  // the preview, so write what they signed off on. No merge logic in this
  // path because edits already include the markers from the preview the
  // user was looking at.
  if (opts.edits != null) {
    await backend.writeFile("CLAUDE.md", opts.edits);
    return;
  }

  // No edits → fresh persona render. If the vault already has a
  // CLAUDE.md, splice managed sections in via the merge utility so
  // user hand-edits outside markers survive.
  const sections = composePersonaSections({
    traits: opts.traits,
    personaFreetext: opts.freetext,
  });

  if (await backend.exists("CLAUDE.md")) {
    const existing = await backend.readFile("CLAUDE.md");
    const merged = mergeIntoExistingClaudeMd(existing, sections);
    await backend.writeFile("CLAUDE.md", merged.merged);
    return;
  }

  // Fresh write — use the flat composer (also includes markers).
  const flat = composePersonaClaudeMd({
    traits: opts.traits,
    personaFreetext: opts.freetext,
  });
  await backend.writeFile("CLAUDE.md", flat);
}
