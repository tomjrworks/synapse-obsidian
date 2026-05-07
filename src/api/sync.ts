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
import { logErrorWithId, respondError } from "./respond-error.js";
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

// H3 (05-01) + H9 (04-30): reject absolute paths, .. traversal, and
// control characters at the schema layer before any I/O.
const safePath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/"), "path must be relative")
  .refine(
    (p) => !p.split("/").includes(".."),
    "path must not contain .. segments",
  )
  .refine(
    (p) => !/[\x00-\x1f\x7f]/.test(p),
    "path must not contain control characters",
  );

const pushSchema = z.object({
  ops: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("upsert"),
          path: safePath,
          content: z.string(),
          mtime: z.string().datetime().optional(),
        }),
        z.object({
          kind: z.literal("delete"),
          path: safePath,
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
      request_id?: string;
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

      // 0.1.7 Phase 0 — DEBUG_SYNC_TIMING probe (gated; env-flip to disable
      // without redeploy). Captures per-op + request-level timing so we can
      // anchor candidate selection on measured throughput, not timeout-window
      // math artifacts. Remove the gate (and this block) once probe is done.
      const debugTiming = process.env.DEBUG_SYNC_TIMING === "1";
      const requestStart = debugTiming ? Date.now() : 0;
      const opTimings: { path: string; ms: number; ok: boolean }[] = [];
      const resolveStart = debugTiming ? Date.now() : 0;

      let backend: Pick<StorageBackend, "writeFile" | "delete">;
      try {
        backend = await resolveBackend(workspaceId);
      } catch (err) {
        respondError(res, 500, "server_error", err, { logPrefix: "sync/push" });
        return;
      }
      const resolveMs = debugTiming ? Date.now() - resolveStart : 0;

      // Sequential ops: predictable Supabase backpressure, isolatable
      // per-op failures. Stage 1 keeps sequential — revisit if push-side
      // throughput surfaces a need.
      const results: PushResultEntry[] = [];
      for (const op of parsed.data.ops) {
        const opStart = debugTiming ? Date.now() : 0;
        let opOk = true;
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
                if (debugTiming) {
                  opTimings.push({
                    path: op.path,
                    ms: Date.now() - opStart,
                    ok: true,
                  });
                }
                continue;
              }
              throw err;
            }
          }
        } catch (err) {
          opOk = false;
          const error =
            err instanceof NotFoundError
              ? "not_found"
              : err instanceof ConflictError
                ? "conflict"
                : "internal";
          const request_id = logErrorWithId(err, error, "sync/push");
          results.push({
            path: op.path,
            ok: false,
            error,
            request_id,
          });
        }
        if (debugTiming) {
          opTimings.push({
            path: op.path,
            ms: Date.now() - opStart,
            ok: opOk,
          });
        }
      }

      const response: PushResponse = { results };

      if (debugTiming) {
        const totalMs = Date.now() - requestStart;
        const sortedMs = [...opTimings].map((t) => t.ms).sort((a, b) => a - b);
        const p50 = sortedMs[Math.floor(sortedMs.length * 0.5)] ?? 0;
        const p95 = sortedMs[Math.floor(sortedMs.length * 0.95)] ?? 0;
        const maxOp = opTimings.reduce((m, t) => (t.ms > m.ms ? t : m), {
          path: "",
          ms: 0,
          ok: true,
        });
        const firstOpMs = opTimings[0]?.ms ?? 0;
        const lastOpMs = opTimings[opTimings.length - 1]?.ms ?? 0;
        console.log(
          JSON.stringify({
            type: "sync/push.timing",
            workspaceId,
            opsCount: parsed.data.ops.length,
            totalMs,
            resolveMs,
            loopMs: totalMs - resolveMs,
            avgMs: opTimings.length
              ? Math.round((totalMs - resolveMs) / opTimings.length)
              : 0,
            p50,
            p95,
            maxMs: maxOp.ms,
            maxPath: maxOp.path,
            firstOpMs,
            lastOpMs,
            failedCount: opTimings.filter((t) => !t.ok).length,
          }),
        );
      }

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
      } catch (err) {
        respondError(res, 500, "server_error", err, { logPrefix: "sync/pull" });
        return;
      }

      const cursor =
        since && since_id ? { modifiedAt: since, id: since_id } : null;

      let result: ListChangedResult;
      try {
        result = await backend.listChanged(cursor, limit);
      } catch (err) {
        respondError(res, 500, "server_error", err, { logPrefix: "sync/pull" });
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
