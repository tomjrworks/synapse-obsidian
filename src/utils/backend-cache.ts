/**
 * Stage 1 T4.7 — SupabaseEncryptedMirrorBackend cache primitive.
 *
 * Cloud-server motivation: every MCP request inbound to the Cloudflare Worker
 * needs a workspace-scoped backend. Constructing one (T4.1
 * `forWorkspace`) is two round-trips + a DEK unwrap + an audit_log insert.
 * Doing that per request would multiply latency on a handler that's
 * supposed to feel instant from claude.ai. Cache the constructed backend
 * per workspace_id with a short TTL.
 *
 * Eviction triggers (callers' responsibility):
 *   - workspace key rotation (T4 follow-up: rotate-kek script will call evict)
 *   - workspace nuke (T4.6): /api/leave invalidates the cache for this
 *     workspace before the user disconnects
 *   - process recycle (TTL handles it)
 *
 * Not wired into routes here — T6 (cloud server) will import getBackend()
 * and use it inside the MCP request path.
 *
 * Per the locked T4 plan: TTL = 5 minutes. Tradeoff: longer = fewer audit
 * rows + faster repeats; shorter = quicker propagation of key rotations
 * and nuke. 5 min is a balance for personal-tools traffic shapes.
 *
 * NOTE on safety: the cached backend holds a DEK in memory. If the process
 * dies, the cache dies with it (no persistence). If the workspace owner
 * nukes mid-request from a different device, the in-flight request will
 * keep working until the cache expires or evict() is called explicitly.
 * That's acceptable — nuke can race in flight; the audit log records both.
 */
import { SupabaseEncryptedMirrorBackend } from "./supabase-mirror.js";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
let ttlMs = DEFAULT_TTL_MS;

interface CacheEntry {
  backend: SupabaseEncryptedMirrorBackend;
  loadedAt: number;
}

const cache = new Map<string, CacheEntry>();

export async function getBackend(
  workspaceId: string,
  opts?: { ip?: string; userAgent?: string },
): Promise<SupabaseEncryptedMirrorBackend> {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.loadedAt < ttlMs) return hit.backend;

  // Cache miss — construct fresh. The audit_log row for this kek_unwrap
  // records the request context (ip, ua) of the first request that caused
  // the backend to be constructed.
  const backend = await SupabaseEncryptedMirrorBackend.forWorkspace(
    workspaceId,
    opts,
  );
  cache.set(workspaceId, { backend, loadedAt: Date.now() });
  return backend;
}

export function evict(workspaceId: string): void {
  cache.delete(workspaceId);
}

export function clearAll(): void {
  cache.clear();
}

// Test-only hook: lets smoke tests set a small TTL to exercise the
// expiry path without sleeping for the full 5 minutes. Production
// callers never touch this — production runs on the default TTL.
export function __setTtlMsForTest(ms: number): void {
  ttlMs = ms;
}

export function __resetTtlMsForTest(): void {
  ttlMs = DEFAULT_TTL_MS;
}
