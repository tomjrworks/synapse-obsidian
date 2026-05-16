import { Router } from "express";
import { supabaseService } from "./supabase.js";
import {
  requireSupabaseAuth,
  requireWorkspace,
  workspaceLimitMiddleware,
  asyncHandler,
  type AuthedWorkspaceRequest,
} from "./middleware.js";
import { patchWorkspaceSettings } from "./workspace.js";
import { respondError } from "./respond-error.js";

export const ONBOARDING_STEPS = [
  "persona",
  "clients",
  "obsidian",
  "helper",
  "permissions",
  "connect",
  "first-wow",
  "rules-review",
  "use-cases",
  "done",
  "complete",
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

// Compat shim: workspaces created before the Obsidian-required pivot
// (2026-05-06) may have onboarding_step="vault" stuck in settings.
// Treat as "obsidian" on read; forward-bumps on next /onboarding/step write.
// See projects/taproot/build/2026-05-07-workstream-a-onboarding-rewrite-task.md
export function coerceLegacyStep(step: string): OnboardingStep {
  return step === "vault" ? "obsidian" : (step as OnboardingStep);
}

export function onboardingRouter(): Router {
  const router = Router();

  router.post(
    "/onboarding/step",
    requireSupabaseAuth,
    requireWorkspace,
    workspaceLimitMiddleware(30),
    asyncHandler(async (req, res) => {
      const { step } = (req.body ?? {}) as { step?: unknown };

      if (
        typeof step !== "string" ||
        !ONBOARDING_STEPS.includes(step as OnboardingStep)
      ) {
        res.status(400).json({
          error: "invalid_step",
          allowed: ONBOARDING_STEPS,
        });
        return;
      }

      const { membership } = req as AuthedWorkspaceRequest;
      const sb = supabaseService();

      // Monotonicity guard: forward-or-equal only.
      // Note: forward-or-equal allows skip-ahead (e.g. persona → complete).
      // The /onboarding/done bypass is closed at the SITE proxy by a
      // precondition that requires current_step === "done".
      const currentStep = coerceLegacyStep(
        membership.settings?.onboarding_step ?? "persona",
      );
      const currentIdx = ONBOARDING_STEPS.indexOf(currentStep);
      const nextIdx = ONBOARDING_STEPS.indexOf(step as OnboardingStep);

      if (currentIdx < 0) {
        respondError(
          res,
          500,
          "invalid_current_step",
          new Error(`unknown current step: ${currentStep}`),
          {
            logPrefix: "onboarding",
          },
        );
        return;
      }

      if (nextIdx < currentIdx) {
        res.status(400).json({
          error: "invalid_step",
          reason: "cannot_move_backward",
          current: currentStep,
          requested: step,
        });
        return;
      }

      const { settings, error } = await patchWorkspaceSettings(
        sb,
        membership.workspaceId,
        { onboarding_step: step },
      );
      if (error) {
        respondError(res, 500, "update_failed", error, {
          logPrefix: "onboarding",
        });
        return;
      }

      res.json({
        workspace_id: membership.workspaceId,
        onboarding_step: settings.onboarding_step,
      });
    }),
  );

  // POST /persona — kept as a no-op acknowledgement for clients that still
  // hit it during onboarding. Trait + freetext inputs are no longer accepted;
  // CLAUDE.md is generated from observed folder structure (see persona-render).
  router.post(
    "/persona",
    requireSupabaseAuth,
    requireWorkspace,
    workspaceLimitMiddleware(30),
    asyncHandler(async (req, res) => {
      const { membership } = req as AuthedWorkspaceRequest;
      const sb = supabaseService();
      // Touch settings to clear any pending persona shape without rewriting it.
      const { settings, error } = await patchWorkspaceSettings(
        sb,
        membership.workspaceId,
        {},
      );
      if (error) {
        respondError(res, 500, "update_failed", error, {
          logPrefix: "onboarding",
        });
        return;
      }
      res.json({
        workspace_id: membership.workspaceId,
        persona: settings.persona ?? null,
      });
    }),
  );

  return router;
}
