import type { Request, Response, NextFunction, RequestHandler } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { supabaseService } from "./supabase.js";
import {
  getMembershipForUser,
  getMembershipForWorkspace,
  type Membership,
} from "./workspace.js";
import { requireAuth, type AuthedMcpRequest } from "../oauth.js";
import { respondError } from "./respond-error.js";

export interface AuthedRequest extends Request {
  user: { id: string; email?: string };
  jwt: string;
}

export interface AuthedWorkspaceRequest extends AuthedRequest {
  membership: Membership;
}

// OAuth-bearer-authenticated request: same shape as the /mcp request type
// (req.workspaceId attached from oauth_tokens). Helper traffic on /api/sync/*
// authenticates with the same OAuth bearer it uses for /mcp, so we re-export
// the type under a route-family-appropriate name.
export type AuthedOAuthRequest = AuthedMcpRequest;

export const requireSupabaseAuth: RequestHandler = async (req, res, next) => {
  const header = req.header("authorization") || req.header("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "missing_bearer_token" });
    return;
  }
  const jwt = header.slice("Bearer ".length).trim();
  if (!jwt) {
    res.status(401).json({ error: "empty_bearer_token" });
    return;
  }
  try {
    const { data, error } = await supabaseService().auth.getUser(jwt);
    if (error || !data.user) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    (req as AuthedRequest).user = { id: data.user.id, email: data.user.email };
    (req as AuthedRequest).jwt = jwt;
    next();
  } catch (err) {
    respondError(res, 401, "auth_failed", err, { logPrefix: "auth" });
  }
};

// Mount AFTER requireSupabaseAuth. Resolves the caller's membership and
// attaches it as req.membership; 404s with `no_workspace` if missing.
// Replaces 11 inline copies of this pattern across the api/ routers.
export const requireWorkspace: RequestHandler = async (req, res, next) => {
  const authed = req as AuthedRequest;
  const sb = supabaseService();
  const membership = await getMembershipForUser(sb, authed.user.id);
  if (!membership) {
    res.status(404).json({ error: "no_workspace" });
    return;
  }
  (req as AuthedWorkspaceRequest).membership = membership;
  next();
};

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Express adapter for `requireAuth` (oauth.ts). `requireAuth` returns
// Promise<boolean> — true means it already wrote a 401/500. This adapter
// turns that into standard middleware shape so OAuth-protected /api/* routes
// can mount it via `router.<verb>("/path", requireOAuthAuth, handler)`.
//
// On success, `req.workspaceId` is attached upstream at oauth.ts:619; cast
// to AuthedOAuthRequest in handlers to read it.
export const requireOAuthAuth: RequestHandler = async (req, res, next) => {
  if (await requireAuth(req, res)) return;
  next();
};

/**
 * Workspace-keyed rate limiter for use INSIDE routers, AFTER the auth
 * middleware has run. Works for both OAuth routes (req.workspaceId set by
 * oauth.ts) and Supabase-JWT routes (req.membership.workspaceId set by
 * requireWorkspace). Falls back to IP keying if neither is present.
 *
 * Rollback: TAPROOT_DISABLE_RATE_LIMIT=1 skips all workspace limits.
 */
export function workspaceLimitMiddleware(max: number, windowSec = 60) {
  return rateLimit({
    windowMs: windowSec * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const wsId =
        (req as AuthedMcpRequest).workspaceId ??
        (req as AuthedWorkspaceRequest).membership?.workspaceId;
      if (wsId) return `ws:${wsId}`;
      const xff = req.headers["x-forwarded-for"];
      const rawIp =
        typeof xff === "string"
          ? xff.split(",")[0].trim()
          : (req.ip ?? "unknown");
      return `ip:${ipKeyGenerator(rawIp)}`;
    },
    skip: () => process.env.TAPROOT_DISABLE_RATE_LIMIT === "1",
  });
}

/**
 * User-ID-keyed rate limiter. Use on endpoints where workspaceId is not yet
 * available at call time (e.g. POST /api/workspace — workspace doesn't exist
 * yet, but Supabase JWT carries user.id).
 *
 * Rollback: TAPROOT_DISABLE_RATE_LIMIT=1 skips.
 */
export function userIdLimitMiddleware(max: number, windowSec = 60) {
  return rateLimit({
    windowMs: windowSec * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const userId = (req as AuthedRequest).user?.id;
      if (userId) return `user:${userId}`;
      const xff = req.headers["x-forwarded-for"];
      const rawIp =
        typeof xff === "string"
          ? xff.split(",")[0].trim()
          : (req.ip ?? "unknown");
      return `ip:${ipKeyGenerator(rawIp)}`;
    },
    skip: () => process.env.TAPROOT_DISABLE_RATE_LIMIT === "1",
  });
}

// Mount AFTER requireOAuthAuth. Resolves membership by workspaceId (from the
// OAuth token row) and synthesizes req.user from the workspace owner. Use on
// routes that need req.membership but are called with a custom bearer rather
// than a Supabase JWT (e.g. GET /api/me from helper-mac direct signin).
export const requireOAuthWorkspace: RequestHandler = async (req, res, next) => {
  const oauthReq = req as AuthedOAuthRequest;
  const workspaceId = oauthReq.workspaceId;
  if (!workspaceId) {
    res.status(401).json({ error: "no_workspace_id" });
    return;
  }
  const sb = supabaseService();
  const membership = await getMembershipForWorkspace(sb, workspaceId);
  if (!membership) {
    res.status(404).json({ error: "no_workspace" });
    return;
  }
  (req as AuthedWorkspaceRequest).membership = membership;
  (req as AuthedWorkspaceRequest).user = {
    id: membership.userId ?? workspaceId,
    email: undefined,
  };
  (req as AuthedWorkspaceRequest).jwt = "";
  next();
};
