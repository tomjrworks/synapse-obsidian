import { Router } from "express";
import { supabaseService } from "./supabase.js";
import {
  requireSupabaseAuth,
  requireWorkspace,
  asyncHandler,
  type AuthedWorkspaceRequest,
} from "./middleware.js";

const HELPER_FRESHNESS_MS = 5 * 60 * 1000;

export function helperRouter(): Router {
  const router = Router();

  router.get(
    "/helper/status",
    requireSupabaseAuth,
    requireWorkspace,
    asyncHandler(async (req, res) => {
      const { membership } = req as AuthedWorkspaceRequest;
      const sb = supabaseService();

      const { data, error } = await sb
        .from("helper_devices")
        .select("device_name, last_seen_at, installed_at, os_platform")
        .eq("workspace_id", membership.workspaceId)
        .is("revoked_at", null)
        .order("last_seen_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        console.error(`[helper/status] lookup_failed: ${error.message}`);
        res.status(500).json({ error: "lookup_failed" });
        return;
      }

      if (!data) {
        res.json({ installed: false, last_seen_at: null });
        return;
      }

      const lastSeen = data.last_seen_at
        ? new Date(data.last_seen_at).getTime()
        : 0;
      const fresh = lastSeen > Date.now() - HELPER_FRESHNESS_MS;

      // vault_path lives in workspaces.settings once T11 lands the helper
      // first-run reporting; for now expose null so the wizard can render
      // the step without breaking on an undefined field.
      const vaultPath =
        typeof membership.settings.vault_path === "string"
          ? (membership.settings.vault_path as string)
          : null;

      res.json({
        installed: fresh,
        last_seen_at: data.last_seen_at,
        device_name: data.device_name,
        os_platform: data.os_platform,
        vault_path: vaultPath,
      });
    }),
  );

  return router;
}
