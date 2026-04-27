import type { Request, Response, NextFunction, RequestHandler } from "express";
import { supabaseService } from "./supabase.js";

export interface AuthedRequest extends Request {
  user: { id: string; email?: string };
  jwt: string;
}

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

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
