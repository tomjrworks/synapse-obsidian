import { Router } from "express";
import { randomBytes } from "node:crypto";
import { supabaseService } from "./supabase.js";
import {
  requireSupabaseAuth,
  requireWorkspace,
  requireOAuthAuth,
  asyncHandler,
  type AuthedWorkspaceRequest,
  type AuthedOAuthRequest,
} from "./middleware.js";
import { respondError } from "./respond-error.js";
import {
  generatePairToken,
  canonicalizePairToken,
  hashPairToken,
  PAIR_TTL_MS,
  PAIR_RATE_LIMIT,
} from "../lib/pair-token.js";
import { tokenHashByteaParam, TOKEN_TTL_SECONDS } from "../auth/bearer.js";
import { patchWorkspaceSettings } from "./workspace.js";

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
        respondError(res, 500, "lookup_failed", error, { logPrefix: "helper" });
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

  // --- Mint ---
  router.get(
    "/helper/pair-token",
    requireSupabaseAuth,
    requireWorkspace,
    asyncHandler(async (req, res) => {
      const authed = req as AuthedWorkspaceRequest;
      const { membership } = authed;
      const sb = supabaseService();
      const workspaceId = membership.workspaceId;

      // Soft-expire the oldest active token when the workspace is at the limit.
      const now = new Date().toISOString();
      const { data: active } = await sb
        .from("pair_tokens")
        .select("token_hash, created_at")
        .eq("workspace_id", workspaceId)
        .is("consumed_at", null)
        .gt("expires_at", now)
        .order("created_at", { ascending: true });

      if (active && active.length >= PAIR_RATE_LIMIT) {
        await sb
          .from("pair_tokens")
          .update({ expires_at: now })
          .eq("token_hash", active[0].token_hash);
      }

      const token = generatePairToken();
      const expiresAt = new Date(Date.now() + PAIR_TTL_MS).toISOString();

      const { error } = await sb.from("pair_tokens").insert({
        token_hash: hashPairToken(token),
        workspace_id: workspaceId,
        user_id: authed.user.id, // membership.userId is undefined for JWT-authed paths
        expires_at: expiresAt,
      });
      if (error) {
        respondError(res, 500, "mint_failed", error, {
          logPrefix: "helper/pair-token",
        });
        return;
      }

      res.json({ token, expires_at: expiresAt });
    }),
  );

  // --- Redeem ---
  router.post(
    "/helper/pair/redeem",
    asyncHandler(async (req, res) => {
      const { code, device_name, os_platform } = req.body ?? {};
      if (
        typeof code !== "string" ||
        typeof device_name !== "string" ||
        typeof os_platform !== "string" ||
        device_name.length === 0 ||
        os_platform.length > 64
      ) {
        respondError(res, 400, "bad_request", null, {
          logPrefix: "helper/pair/redeem",
        });
        return;
      }

      const canonical = canonicalizePairToken(code);
      if (!canonical) {
        respondError(res, 400, "bad_request", null, {
          logPrefix: "helper/pair/redeem",
        });
        return;
      }

      const sb = supabaseService();
      const pairHash = hashPairToken(canonical);

      const { data: pairRow, error: lookupErr } = await sb
        .from("pair_tokens")
        .select("workspace_id, user_id, consumed_at, expires_at")
        .eq("token_hash", pairHash)
        .maybeSingle();

      if (lookupErr || !pairRow) {
        respondError(res, 404, "invalid_code", lookupErr, {
          logPrefix: "helper/pair/redeem",
        });
        return;
      }
      if (pairRow.consumed_at !== null) {
        respondError(res, 409, "already_consumed", null, {
          logPrefix: "helper/pair/redeem",
        });
        return;
      }
      if (new Date(pairRow.expires_at) < new Date()) {
        respondError(res, 410, "expired", null, {
          logPrefix: "helper/pair/redeem",
        });
        return;
      }

      const workspaceId = pairRow.workspace_id as string;

      // Generate bearer; device_secret_hash = sha256(bearer) stored in helper_devices.
      const bearer = randomBytes(32).toString("hex");
      const bearerHashParam = tokenHashByteaParam(bearer);
      const expiresAt = new Date(
        Date.now() + TOKEN_TTL_SECONDS * 1000,
      ).toISOString();

      // Upsert synthetic OAuth client (required by oauth_tokens.client_id NOT NULL FK).
      const syntheticClientId = `taproot-helper-${workspaceId}`;
      const { error: clientErr } = await sb.from("oauth_clients").upsert(
        {
          workspace_id: workspaceId,
          client_id: syntheticClientId,
          client_name: "Taproot Helper",
          redirect_uris: ["taproot://auth"],
          last_authorized_at: new Date().toISOString(),
        },
        { onConflict: "client_id" },
      );
      if (clientErr) {
        respondError(res, 500, "redeem_failed", clientErr, {
          logPrefix: "helper/pair/redeem",
        });
        return;
      }

      // Register device.
      const { data: deviceRow, error: deviceErr } = await sb
        .from("helper_devices")
        .insert({
          workspace_id: workspaceId,
          device_name,
          os_platform,
          device_secret_hash: bearerHashParam,
        })
        .select("id")
        .single();
      if (deviceErr || !deviceRow) {
        respondError(res, 500, "redeem_failed", deviceErr, {
          logPrefix: "helper/pair/redeem",
        });
        return;
      }

      // Mint bearer token.
      const { error: tokenErr } = await sb.from("oauth_tokens").insert({
        workspace_id: workspaceId,
        client_id: syntheticClientId,
        token_hash: bearerHashParam,
        expires_at: expiresAt,
        scopes: ["helper"],
      });
      if (tokenErr) {
        respondError(res, 500, "redeem_failed", tokenErr, {
          logPrefix: "helper/pair/redeem",
        });
        return;
      }

      // Mark pair token consumed; treat 0 rows updated as a race (409).
      const { data: consumed, error: consumeErr } = await sb
        .from("pair_tokens")
        .update({
          consumed_at: new Date().toISOString(),
          consumed_by_device_id: deviceRow.id,
        })
        .eq("token_hash", pairHash)
        .is("consumed_at", null)
        .select("token_hash");
      if (consumeErr || !consumed || consumed.length === 0) {
        respondError(
          res,
          consumeErr ? 500 : 409,
          consumeErr ? "redeem_failed" : "already_consumed",
          consumeErr,
          { logPrefix: "helper/pair/redeem" },
        );
        return;
      }

      res.json({
        bearer,
        workspace_id: workspaceId,
        device_id: deviceRow.id,
        expires_at: expiresAt,
      });
    }),
  );

  // --- Heartbeat ---
  router.put(
    "/helper/heartbeat",
    requireOAuthAuth,
    asyncHandler(async (req, res) => {
      const { workspaceId } = req as AuthedOAuthRequest;
      const bearer = (req.headers.authorization ?? "").slice(7); // "Bearer ".length
      const sb = supabaseService();

      const { data: device, error: lookupErr } = await sb
        .from("helper_devices")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("device_secret_hash", tokenHashByteaParam(bearer))
        .is("revoked_at", null)
        .select("id, last_seen_at")
        .maybeSingle();

      if (lookupErr) {
        respondError(res, 500, "heartbeat_failed", lookupErr, {
          logPrefix: "helper/heartbeat",
        });
        return;
      }
      if (!device) {
        respondError(res, 404, "device_not_found", null, {
          logPrefix: "helper/heartbeat",
        });
        return;
      }

      const { vault_path } = req.body ?? {};
      if (typeof vault_path === "string" && vault_path.length > 0) {
        const { error: patchErr } = await patchWorkspaceSettings(
          sb,
          workspaceId,
          { vault_path },
        );
        if (patchErr) {
          respondError(res, 500, "heartbeat_failed", patchErr, {
            logPrefix: "helper/heartbeat",
          });
          return;
        }
      }

      res.json({ ok: true, last_seen_at: device.last_seen_at });
    }),
  );

  return router;
}
