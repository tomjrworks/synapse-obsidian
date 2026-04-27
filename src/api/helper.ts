import { Router } from "express";
import { randomBytes } from "node:crypto";
import { supabaseService } from "./supabase.js";
import {
  requireSupabaseAuth,
  asyncHandler,
  type AuthedRequest,
} from "./middleware.js";
import { getMembershipForUser } from "./workspace.js";

const PAIR_TOKEN_TTL_MS = 15 * 60 * 1000;
const HELPER_FRESHNESS_MS = 5 * 60 * 1000;

export function helperRouter(): Router {
  const router = Router();

  router.get(
    "/helper/status",
    requireSupabaseAuth,
    asyncHandler(async (req, res) => {
      const sb = supabaseService();
      const userId = (req as AuthedRequest).user.id;
      const membership = await getMembershipForUser(sb, userId);
      if (!membership) {
        res.status(404).json({ error: "no_workspace" });
        return;
      }

      const { data, error } = await sb
        .from("helper_devices")
        .select("device_name, last_seen_at, installed_at, os_platform")
        .eq("workspace_id", membership.workspaceId)
        .is("revoked_at", null)
        .order("last_seen_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        res.status(500).json({ error: "lookup_failed", detail: error.message });
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

  router.post(
    "/helper/pair-token",
    requireSupabaseAuth,
    asyncHandler(async (req, res) => {
      const sb = supabaseService();
      const userId = (req as AuthedRequest).user.id;
      const membership = await getMembershipForUser(sb, userId);
      if (!membership) {
        res.status(404).json({ error: "no_workspace" });
        return;
      }

      const token = randomBytes(24).toString("base64url");
      const expiresAt = new Date(Date.now() + PAIR_TOKEN_TTL_MS).toISOString();

      const { error } = await sb.from("pair_tokens").insert({
        token,
        workspace_id: membership.workspaceId,
        expires_at: expiresAt,
      });
      if (error) {
        res
          .status(500)
          .json({ error: "token_insert_failed", detail: error.message });
        return;
      }

      res.json({
        token,
        expires_at: expiresAt,
        ttl_seconds: PAIR_TOKEN_TTL_MS / 1000,
      });
    }),
  );

  return router;
}
