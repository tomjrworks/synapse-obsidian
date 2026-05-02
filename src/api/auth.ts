import { randomUUID } from "node:crypto";
import { Router } from "express";
import { supabaseService } from "./supabase.js";
import { generateDek, wrapDek } from "./crypto.js";
import { asyncHandler } from "./middleware.js";

export function authRouter(): Router {
  const router = Router();

  router.post(
    "/signup",
    asyncHandler(async (req, res) => {
      const { email, password, workspace_name } = (req.body ?? {}) as {
        email?: unknown;
        password?: unknown;
        workspace_name?: unknown;
      };

      if (typeof email !== "string" || !email.includes("@")) {
        res.status(400).json({ error: "invalid_email" });
        return;
      }
      if (typeof password !== "string" || password.length < 8) {
        res
          .status(400)
          .json({ error: "password_too_short", detail: "min 8 chars" });
        return;
      }

      const sb = supabaseService();
      const { data: signupData, error: signupError } = await sb.auth.signUp({
        email,
        password,
      });
      if (signupError) {
        res
          .status(400)
          .json({ error: "signup_failed", detail: signupError.message });
        return;
      }
      if (!signupData.user) {
        res.status(500).json({ error: "signup_no_user_returned" });
        return;
      }
      const userId = signupData.user.id;

      const wsName =
        typeof workspace_name === "string" && workspace_name.trim()
          ? workspace_name.trim()
          : `${email.split("@")[0]}'s garden`;

      const workspaceId = randomUUID();
      const dek = generateDek();
      const wrapped = wrapDek(dek, workspaceId);
      // PostgREST/Postgres bytea literal format: \x followed by hex.
      const wrappedDekParam = `\\x${wrapped.toString("hex")}`;

      const { data: rpcWorkspaceId, error: rpcError } = await sb.rpc(
        "create_workspace_for_new_user",
        {
          p_workspace_id: workspaceId,
          p_user_id: userId,
          p_workspace_name: wsName,
          p_wrapped_dek: wrappedDekParam,
        },
      );

      if (rpcError) {
        try {
          await sb.auth.admin.deleteUser(userId);
        } catch (cleanupErr: any) {
          console.error(
            `[signup] orphan auth.users row ${userId} — manual cleanup needed:`,
            cleanupErr?.message,
          );
        }
        res.status(500).json({
          error: "workspace_create_failed",
          detail: rpcError.message,
        });
        return;
      }

      res.json({
        user_id: userId,
        workspace_id: workspaceId,
        jwt: signupData.session?.access_token ?? null,
        needs_email_confirmation: !signupData.session,
      });
    }),
  );

  router.post(
    "/login",
    asyncHandler(async (req, res) => {
      const { email, password } = (req.body ?? {}) as {
        email?: unknown;
        password?: unknown;
      };

      if (typeof email !== "string" || !email.includes("@")) {
        res.status(400).json({ error: "invalid_email" });
        return;
      }
      if (typeof password !== "string" || !password) {
        res.status(400).json({ error: "missing_password" });
        return;
      }

      const sb = supabaseService();
      const { data, error } = await sb.auth.signInWithPassword({
        email,
        password,
      });
      if (error) {
        res.status(401).json({ error: "login_failed", detail: error.message });
        return;
      }
      if (!data.session || !data.user) {
        res.status(401).json({ error: "no_session_returned" });
        return;
      }

      res.json({
        user_id: data.user.id,
        jwt: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
      });
    }),
  );

  router.post(
    "/magic-link",
    asyncHandler(async (req, res) => {
      const { email } = (req.body ?? {}) as { email?: unknown };

      if (typeof email !== "string" || !email.includes("@")) {
        res.status(400).json({ error: "invalid_email" });
        return;
      }

      const sb = supabaseService();
      const { error } = await sb.auth.signInWithOtp({ email });
      if (error) {
        res
          .status(400)
          .json({ error: "magic_link_failed", detail: error.message });
        return;
      }

      res.json({ ok: true });
    }),
  );

  return router;
}
