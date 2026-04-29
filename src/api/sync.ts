/**
 * Stage 1 T11.3 — POST /api/sync/push.
 *
 * The macOS helper watches a workspace's local folder via FSEventStream
 * (T11.2) and posts coalesced batches of file changes here. The server
 * resolves the workspace-scoped encrypted mirror (`getBackend` cache,
 * T4.7) and applies each op through the same StorageBackend interface
 * used by /mcp.
 *
 * Auth: OAuth bearer (NOT Supabase JWT) — same token shape as /mcp.
 * `requireOAuthAuth` (middleware.ts) attaches `req.workspaceId` from
 * oauth_tokens.
 *
 * Per-op errors do NOT reject the batch — each op gets its own result.
 * Top-level 4xx/5xx is reserved for auth, body parse, and backend
 * resolution failures.
 */
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import {
  asyncHandler,
  requireOAuthAuth,
  type AuthedOAuthRequest,
} from "./middleware.js";
import { getBackend as defaultGetBackend } from "../utils/backend-cache.js";
import {
  ConflictError,
  NotFoundError,
  type StorageBackend,
} from "../utils/storage.js";

// Pick<StorageBackend, "writeFile" | "delete"> instead of typeof
// defaultGetBackend so the unit smoke can stub a minimal object — production
// callers pass a SupabaseEncryptedMirrorBackend which is assignable.
type BackendResolver = (
  workspaceId: string,
) => Promise<Pick<StorageBackend, "writeFile" | "delete">>;

interface SyncRouterOptions {
  getBackend?: BackendResolver;
  // Test-only seam. Production callers pass nothing and get
  // `requireOAuthAuth` (validates OAuth bearer + attaches req.workspaceId).
  // The handler smoke replaces this with a stub that seeds workspaceId
  // directly so it can run without Supabase. Plan §2.7 used a positional
  // getBackend arg; bumped to an options object to add this seam — no
  // production callers exist yet.
  requireAuth?: RequestHandler;
}

const pushSchema = z.object({
  ops: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("upsert"),
          path: z.string().min(1),
          content: z.string(),
          mtime: z.string().datetime().optional(),
        }),
        z.object({
          kind: z.literal("delete"),
          path: z.string().min(1),
        }),
      ]),
    )
    .min(1)
    .max(500),
});

type PushOp = z.infer<typeof pushSchema>["ops"][number];

type PushResultEntry =
  | { path: string; ok: true }
  | {
      path: string;
      ok: false;
      error: "not_found" | "conflict" | "internal";
      detail?: string;
    };

interface PushResponse {
  results: PushResultEntry[];
}

export function syncRouter(opts: SyncRouterOptions = {}): Router {
  const router = Router();
  const authMiddleware = opts.requireAuth ?? requireOAuthAuth;
  const resolveBackend = opts.getBackend ?? defaultGetBackend;

  router.post(
    "/sync/push",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const parsed = pushSchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: "invalid_body", detail: parsed.error.format() });
        return;
      }

      const { workspaceId } = req as AuthedOAuthRequest;
      let backend: Pick<StorageBackend, "writeFile" | "delete">;
      try {
        backend = await resolveBackend(workspaceId);
      } catch (err: any) {
        res.status(500).json({
          error: "server_error",
          detail: err?.message ?? String(err),
        });
        return;
      }

      // Sequential ops: predictable Supabase backpressure, isolatable
      // per-op failures. T11.4 will revisit batching shape once the pull
      // engine lands.
      const results: PushResultEntry[] = [];
      for (const op of parsed.data.ops) {
        try {
          if (op.kind === "upsert") {
            await backend.writeFile(op.path, op.content);
            results.push({ path: op.path, ok: true });
          } else {
            try {
              await backend.delete(op.path);
              results.push({ path: op.path, ok: true });
            } catch (err) {
              if (err instanceof NotFoundError) {
                // Idempotent delete: already absent counts as success.
                results.push({ path: op.path, ok: true });
                continue;
              }
              throw err;
            }
          }
        } catch (err: any) {
          const error =
            err instanceof NotFoundError
              ? "not_found"
              : err instanceof ConflictError
                ? "conflict"
                : "internal";
          results.push({
            path: op.path,
            ok: false,
            error,
            detail: err?.message ?? String(err),
          });
        }
      }

      const response: PushResponse = { results };
      res.json(response);
    }),
  );

  return router;
}
