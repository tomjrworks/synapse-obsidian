/**
 * Stage 1 T11.3 + T11.4 — sync endpoints.
 *
 * POST /api/sync/push (T11.3): the macOS helper watches a workspace's local
 * folder via FSEventStream (T11.2) and posts coalesced batches of file
 * changes here. Server resolves the workspace-scoped encrypted mirror
 * (`getBackend` cache, T4.7) and applies each op through the same
 * StorageBackend interface used by /mcp.
 *
 * GET /api/sync/pull (T11.4): the helper polls this endpoint every 30s
 * (configurable via TAPROOT_PULL_INTERVAL_MS) for vault changes since a
 * `(modified_at, id)` tuple cursor. Server returns metadata + inline
 * decrypted plaintext for non-deleted rows (D1.a — helper has no decrypt
 * path of its own). Cursor is round-tripped via `next_since` / `next_since_id`
 * and persisted on the helper in UserDefaults.
 *
 * Auth: OAuth bearer (NOT Supabase JWT) — same token shape as /mcp.
 * `requireOAuthAuth` (middleware.ts) attaches `req.workspaceId` from
 * oauth_tokens.
 *
 * Per-op errors do NOT reject the push batch — each op gets its own result.
 * Top-level 4xx/5xx is reserved for auth, body parse, and backend resolution
 * failures.
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
  type ListChangedResult,
  type StorageBackend,
} from "../utils/storage.js";

// Pick<StorageBackend, "writeFile" | "delete" | "listChanged"> instead of typeof
// defaultGetBackend so the unit smoke can stub a minimal object — production
// callers pass a SupabaseEncryptedMirrorBackend which is assignable.
type BackendResolver = (
  workspaceId: string,
) => Promise<Pick<StorageBackend, "writeFile" | "delete" | "listChanged">>;

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

// T11.4 pull schema. `since` and `since_id` are tied — provide both or
// neither (refine guard below). `limit` defaults to 500 (= helper page size)
// and is `coerce`d because Express parses query strings as strings.
//
// `datetime({ offset: true })` accepts BOTH `Z` and `+HH:MM` ISO8601 forms.
// Required because PostgREST emits timestamptz columns as `+00:00` rather
// than `Z`, and the helper round-trips the cursor token verbatim — without
// `offset: true` every cursor pull would 400 with "Invalid datetime."
const pullQuerySchema = z
  .object({
    since: z.string().datetime({ offset: true }).optional(),
    since_id: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(500),
  })
  .refine((q) => (q.since === undefined) === (q.since_id === undefined), {
    message: "since and since_id must be provided together",
  });

interface PullFileEntry {
  path: string;
  size: number;
  mtime: string; // ISO8601 of vault_files.modified_at
  deleted: boolean;
  content?: string; // plaintext for non-deleted rows (D1.a inline)
}

interface PullResponse {
  files: PullFileEntry[];
  next_since: string | null;
  next_since_id: string | null;
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
      // per-op failures. Stage 1 keeps sequential — revisit if push-side
      // throughput surfaces a need.
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

  router.get(
    "/sync/pull",
    authMiddleware,
    asyncHandler(async (req, res) => {
      const parsed = pullQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: "invalid_query", detail: parsed.error.format() });
        return;
      }
      const { since, since_id, limit } = parsed.data;
      const { workspaceId } = req as AuthedOAuthRequest;

      let backend: Pick<StorageBackend, "writeFile" | "delete" | "listChanged">;
      try {
        backend = await resolveBackend(workspaceId);
      } catch (err: any) {
        res.status(500).json({
          error: "server_error",
          detail: err?.message ?? String(err),
        });
        return;
      }

      const cursor =
        since && since_id ? { modifiedAt: since, id: since_id } : null;

      let result: ListChangedResult;
      try {
        result = await backend.listChanged(cursor, limit);
      } catch (err: any) {
        console.error(
          `[sync/pull] listChanged failed (workspace=${workspaceId}): ${err?.message ?? err}`,
        );
        res
          .status(500)
          .json({ error: "server_error", detail: err?.message ?? String(err) });
        return;
      }

      const files: PullFileEntry[] = result.files.map((f) => ({
        path: f.path,
        size: f.size,
        mtime: f.modifiedAt,
        deleted: f.deleted,
        ...(f.content !== undefined ? { content: f.content } : {}),
      }));

      const response: PullResponse = {
        files,
        next_since: result.next?.modifiedAt ?? null,
        next_since_id: result.next?.id ?? null,
      };
      res.json(response);
    }),
  );

  return router;
}
