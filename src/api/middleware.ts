import type { Request, Response, NextFunction, RequestHandler } from "express";
import { supabaseService } from "./supabase.js";
import { getMembershipForUser, type Membership } from "./workspace.js";
import { requireAuth, type AuthedMcpRequest } from "../oauth.js";

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
  } catch (err: any) {
    res.status(401).json({ error: "auth_failed", detail: err.message });
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
