/**
 * 0.1.7 Phase 2 — transient-error retry helper for /sync/push parallelism.
 *
 * Used by `supabase-mirror.ts` to wrap Supabase Storage uploads + each
 * PostgREST round-trip in `upsertMetadata`. At concurrency=10 in
 * /api/sync/push, transient 429/5xx storms are statistically more likely
 * than at sequential concurrency=1 — this helper absorbs them with a small
 * exponential backoff so the per-op result still resolves successfully.
 *
 * Transient classification: HTTP 429/500/502/503/504 OR network codes
 * (ECONNRESET/ETIMEDOUT/EAI_AGAIN/ENETUNREACH/ECONNREFUSED) OR fetch
 * `TypeError` (undici network failure shape).
 *
 * Non-transient errors (validation, auth, NotFoundError, ConflictError,
 * PG_UNIQUE_VIOLATION 23505) are re-thrown immediately on the first attempt.
 *
 * Caller pattern: supabase-js Storage + PostgREST return errors via
 * `{ data, error }` rather than throwing. Wrap the call in `withRetry(async
 * () => { check; throw transient-tagged or user-facing })` so the helper
 * sees thrown errors only.
 */

const TRANSIENT_HTTP = new Set([429, 500, 502, 503, 504]);
const TRANSIENT_NET_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ECONNREFUSED",
]);

export function isTransient(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: string;
    status?: number | string;
    statusCode?: number | string;
    name?: string;
  };
  if (e.status !== undefined && TRANSIENT_HTTP.has(Number(e.status)))
    return true;
  if (e.statusCode !== undefined && TRANSIENT_HTTP.has(Number(e.statusCode)))
    return true;
  if (e.code && TRANSIENT_NET_CODES.has(e.code)) return true;
  if (e.name === "TypeError") return true;
  return false;
}

export interface RetryOpts {
  attempts?: number;
  baseMs?: number;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 100;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !isTransient(err)) throw err;
      const delay = baseMs * 2 ** i;
      const jittered = delay * (0.75 + Math.random() * 0.5);
      const e = err as {
        code?: string;
        status?: number | string;
        statusCode?: number | string;
        message?: string;
        headers?: Record<string, string>;
      };
      console.warn(`withRetry: transient err on attempt ${i + 1}/${attempts}`, {
        code: e.code,
        status: e.status ?? e.statusCode,
        message: e.message,
      });
      let waitMs = jittered;
      const retryAfterRaw =
        e.headers?.["retry-after"] ?? e.headers?.["Retry-After"];
      if (retryAfterRaw) {
        const retryAfterMs = Number(retryAfterRaw) * 1_000;
        if (
          Number.isFinite(retryAfterMs) &&
          retryAfterMs > 0 &&
          retryAfterMs < 60_000
        ) {
          waitMs = Math.max(jittered, retryAfterMs);
        }
      }
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}
