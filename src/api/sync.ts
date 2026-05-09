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
  workspaceLimitMiddleware,
  type AuthedOAuthRequest,
} from "./middleware.js";
import { getBackend as defaultGetBackend } from "../utils/backend-cache.js";
import {
  ConflictError,
  NotFoundError,
  type ListChangedResult,
  type StorageBackend,
} from "../utils/storage.js";

// Pick<StorageBackend, ...> instead of typeof defaultGetBackend so the unit
// smoke can stub a minimal object — production callers pass a
// SupabaseEncryptedMirrorBackend which is assignable.
type BackendResolver = (
  workspaceId: string,
) => Promise<
  Pick<
    StorageBackend,
    "writeFile" | "delete" | "listChanged" | "getCursorHead" | "getPendingCount"
  >
>;

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
  pending_count: number; // rows remaining after this page; 0 = caught up
}

export function syncRouter(opts: SyncRouterOptions = {}): Router {
  const router = Router();
  const authMiddleware = opts.requireAuth ?? requireOAuthAuth;
  const resolveBackend = opts.getBackend ?? defaultGetBackend;

  router.post(
    "/sync/push",
    authMiddleware,
    workspaceLimitMiddleware(60), // 60 push batches/min/workspace; 825-file initial sync = 9 batches → 6× headroom
    asyncHandler(async (req, res) => {
      const parsed = pushSchema.safeParse(req.body);
      if (!parsed.success) {
        respondError(res, 400, "sync_push_invalid_body", parsed.error);
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

      // 0.1.7 Phase 2: chunked Promise.all parallelism. Per-op failures are
      // absorbed inside processOp and returned as PushResultEntry, so the
      // Promise.all chunks never reject. Concurrency is read at handler
      // start from SYNC_PARALLELISM (default 10) so Railway env-flips take
      // effect on the next request without redeploy. =1 degenerates to
      // sequential (chunk size 1) — equivalent to pre-(c) behavior.
      const parallelismRaw = parseInt(process.env.SYNC_PARALLELISM ?? "10", 10);
      const concurrency = Math.max(
        1,
        isNaN(parallelismRaw) ? 10 : parallelismRaw,
      );

      type PushOp = (typeof parsed.data.ops)[number];
      const processOp = async (op: PushOp): Promise<PushResultEntry> => {
        const opStart = debugTiming ? Date.now() : 0;
        let opOk = true;
        let entry: PushResultEntry;
        try {
          if (op.kind === "upsert") {
            await backend.writeFile(op.path, op.content);
            entry = { path: op.path, ok: true };
          } else {
            try {
              await backend.delete(op.path);
              entry = { path: op.path, ok: true };
            } catch (err) {
              if (err instanceof NotFoundError) {
                // Idempotent delete: already absent counts as success.
                // Push timing BEFORE early-return to mirror the pre-(c)
                // pattern at sync.ts:195-201 (no end-of-function duplicate).
                if (debugTiming) {
                  opTimings.push({
                    path: op.path,
                    ms: Date.now() - opStart,
                    ok: true,
                  });
                }
                return { path: op.path, ok: true };
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
          entry = { path: op.path, ok: false, error, request_id };
        }
        if (debugTiming) {
          opTimings.push({
            path: op.path,
            ms: Date.now() - opStart,
            ok: opOk,
          });
        }
        return entry;
      };

      const results: PushResultEntry[] = [];
      for (let i = 0; i < parsed.data.ops.length; i += concurrency) {
        const chunk = parsed.data.ops.slice(i, i + concurrency);
        const chunkResults = await Promise.all(
          chunk.map((op) => processOp(op)),
        );
        results.push(...chunkResults);
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
    workspaceLimitMiddleware(60), // helper polls every 30s ≈ 2/min → 30× headroom
    asyncHandler(async (req, res) => {
      const parsed = pullQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        respondError(res, 400, "sync_pull_invalid_query", parsed.error);
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
        pending_count: result.pendingCount,
      };
      res.json(response);
    }),
  );

  // Blocker 1 — between-tick "X files behind" visibility. Helper calls this
  // at the start of each pullTick BEFORE flipping to .syncing so the menu can
  // show "3 files behind · Synced HH:MM" during the 30s idle window. Reuses
  // the pull cursor schema verbatim — same input shape, different output.
  // Rollback gate: PENDING_COUNT_DISABLED=1 → returns { pending_count: 0 }
  // without touching Supabase (helper sees 0, menu stays on "Synced").
  router.get(
    "/sync/pending-count",
    authMiddleware,
    workspaceLimitMiddleware(60),
    asyncHandler(async (req, res) => {
      const parsed = pullQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        respondError(
          res,
          400,
          "sync_pending_count_invalid_query",
          parsed.error,
        );
        return;
      }
      if (process.env.PENDING_COUNT_DISABLED === "1") {
        res.json({ pending_count: 0 });
        return;
      }
      const { since, since_id } = parsed.data;
      const cursor =
        since && since_id ? { modifiedAt: since, id: since_id } : null;
      if (!cursor) {
        // No cursor = caller has no baseline ("behind" is undefined). Return 0
        // rather than total files so the helper menu doesn't flash a huge
        // count at first launch before the cursor is seeded.
        res.json({ pending_count: 0 });
        return;
      }

      const { workspaceId } = req as AuthedOAuthRequest;
      let backend: Pick<
        StorageBackend,
        "writeFile" | "delete" | "listChanged" | "getPendingCount"
      >;
      try {
        backend = await resolveBackend(workspaceId);
      } catch (err) {
        respondError(res, 500, "server_error", err, {
          logPrefix: "sync/pending-count",
        });
        return;
      }
      let pending: number;
      try {
        pending = await backend.getPendingCount(cursor);
      } catch (err) {
        respondError(res, 500, "server_error", err, {
          logPrefix: "sync/pending-count",
        });
        return;
      }
      res.json({ pending_count: pending });
    }),
  );

  router.get(
    "/sync/cursor-head",
    authMiddleware,
    workspaceLimitMiddleware(60),
    asyncHandler(async (req, res) => {
      const { workspaceId } = req as AuthedOAuthRequest;
      let backend: Pick<
        StorageBackend,
        "writeFile" | "delete" | "listChanged" | "getCursorHead"
      >;
      try {
        backend = await resolveBackend(workspaceId);
      } catch (err) {
        respondError(res, 500, "server_error", err, {
          logPrefix: "sync/cursor-head",
        });
        return;
      }
      let head: { modifiedAt: string; id: string } | null;
      try {
        head = await backend.getCursorHead();
      } catch (err) {
        respondError(res, 500, "server_error", err, {
          logPrefix: "sync/cursor-head",
        });
        return;
      }
      res.json({
        next_since: head?.modifiedAt ?? null,
        next_since_id: head?.id ?? null,
      });
    }),
  );

  return router;
}
