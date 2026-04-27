import { Router } from "express";
import { supabaseService } from "./supabase.js";
import {
  requireSupabaseAuth,
  asyncHandler,
  type AuthedRequest,
} from "./middleware.js";

export function meRouter(): Router {
  const router = Router();

  router.get(
    "/me",
    requireSupabaseAuth,
    asyncHandler(async (req, res) => {
      const authed = req as AuthedRequest;
      const userId = authed.user.id;
      const sb = supabaseService();

      const { data, error } = await sb
        .from("workspace_members")
        .select("workspace_id, joined_at, workspaces!inner(id, settings)")
        .eq("user_id", userId)
        .order("joined_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (error) {
        res.status(500).json({ error: "lookup_failed", detail: error.message });
        return;
      }
      if (!data) {
        res.status(404).json({ error: "no_workspace" });
        return;
      }

      const ws = (data as any).workspaces;
      const settings = ws.settings ?? {};
      const persona = settings.persona ?? {};

      res.json({
        user_id: userId,
        email: authed.user.email,
        workspace_id: ws.id,
        onboarding_step: settings.onboarding_step ?? null,
        persona_traits: Array.isArray(persona.traits) ? persona.traits : [],
        persona_freetext:
          typeof persona.freetext === "string" ? persona.freetext : null,
        connected_clients: Array.isArray(settings.connected_clients)
          ? settings.connected_clients
          : [],
      });
    }),
  );

  return router;
}
