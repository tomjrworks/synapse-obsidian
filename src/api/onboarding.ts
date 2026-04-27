import { Router } from "express";
import { supabaseService } from "./supabase.js";
import {
  requireSupabaseAuth,
  asyncHandler,
  type AuthedRequest,
} from "./middleware.js";
import { getMembershipForUser, patchWorkspaceSettings } from "./workspace.js";

const ONBOARDING_STEPS = [
  "persona",
  "vault_folder",
  "obsidian",
  "helper",
  "permissions",
  "clients",
  "first_wow",
  "complete",
] as const;
type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

const PERSONA_TRAITS = [
  "founder",
  "writer-researcher",
  "creator-designer",
  "salesperson",
  "student",
  "life-os",
  "professional-services",
] as const;
type PersonaTrait = (typeof PERSONA_TRAITS)[number];

export function onboardingRouter(): Router {
  const router = Router();

  router.post(
    "/onboarding/step",
    requireSupabaseAuth,
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

      const sb = supabaseService();
      const userId = (req as AuthedRequest).user.id;
      const membership = await getMembershipForUser(sb, userId);
      if (!membership) {
        res.status(404).json({ error: "no_workspace" });
        return;
      }

      const { settings, error } = await patchWorkspaceSettings(
        sb,
        membership.workspaceId,
        { onboarding_step: step },
      );
      if (error) {
        res.status(500).json({ error: "update_failed", detail: error });
        return;
      }

      res.json({
        workspace_id: membership.workspaceId,
        onboarding_step: settings.onboarding_step,
      });
    }),
  );

  router.post(
    "/persona",
    requireSupabaseAuth,
    asyncHandler(async (req, res) => {
      const { traits, freetext } = (req.body ?? {}) as {
        traits?: unknown;
        freetext?: unknown;
      };

      if (!Array.isArray(traits) || traits.length === 0) {
        res.status(400).json({
          error: "invalid_traits",
          detail: "traits must be a non-empty array",
        });
        return;
      }
      const invalid = traits.filter(
        (t) =>
          typeof t !== "string" || !PERSONA_TRAITS.includes(t as PersonaTrait),
      );
      if (invalid.length > 0) {
        res.status(400).json({
          error: "unknown_trait",
          unknown: invalid,
          allowed: PERSONA_TRAITS,
        });
        return;
      }
      if (freetext !== undefined && typeof freetext !== "string") {
        res.status(400).json({ error: "freetext_must_be_string" });
        return;
      }

      const sb = supabaseService();
      const userId = (req as AuthedRequest).user.id;
      const membership = await getMembershipForUser(sb, userId);
      if (!membership) {
        res.status(404).json({ error: "no_workspace" });
        return;
      }

      const persona = {
        traits: traits as string[],
        ...(typeof freetext === "string" ? { freetext } : {}),
      };

      const { settings, error } = await patchWorkspaceSettings(
        sb,
        membership.workspaceId,
        { persona },
      );
      if (error) {
        res.status(500).json({ error: "update_failed", detail: error });
        return;
      }

      res.json({
        workspace_id: membership.workspaceId,
        persona: settings.persona,
      });
    }),
  );

  return router;
}
