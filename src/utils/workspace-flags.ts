import { LRUCache } from "lru-cache";
import { supabaseService } from "../api/supabase.js";

/**
 * Per-workspace feature flags from `workspaces.settings` (jsonb). Option B of the
 * Pass 3 cohort-flag rollout (decision 2026-06-03-pass-3-cohort-flag-rollout):
 * flip V2 for ONE workspace with a DB write — no redeploy — instead of the
 * fleet-synchronized env flip (review CONCERN #2).
 *
 * Read once per workspace per TTL and cached, mirroring the backend cache's
 * 5-min window (backend-cache.ts): a flip propagates within ≤5 min, the same
 * lag as key-rotation/nuke, and a query never pays a settings round-trip on a
 * cache hit. Resolved upstream in createMcpServer (server.ts) so the per-request
 * cost is one cache lookup, not a DB read.
 */

const TTL_MS = 5 * 60 * 1000;
const cache = new LRUCache<string, boolean>({ max: 5_000, ttl: TTL_MS });

/**
 * Resolve `settings.retrieval_v2` for a workspace. Fail-safe: any error (network,
 * missing row, malformed settings) resolves to FALSE — a flag read must never
 * promote a workspace to V2 by accident, and never throw into the request path.
 */
export async function retrievalV2Setting(
  workspaceId: string,
): Promise<boolean> {
  const hit = cache.get(workspaceId);
  if (hit !== undefined) return hit;

  let enabled = false;
  try {
    const { data, error } = await supabaseService()
      .from("workspaces")
      .select("settings")
      .eq("id", workspaceId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    enabled =
      (data?.settings as { retrieval_v2?: unknown } | null)?.retrieval_v2 ===
      true;
  } catch (err) {
    console.error(
      `[workspace-flags] retrieval_v2 read failed for ${workspaceId}: ${err}`,
    );
    enabled = false;
  }
  cache.set(workspaceId, enabled);
  return enabled;
}

/** Drop a cached entry — call right after flipping the flag so the change is
 * visible immediately instead of waiting out the TTL (the admin script uses it). */
export function invalidateRetrievalV2Setting(workspaceId: string): void {
  cache.delete(workspaceId);
}

/** Test seam — clear the whole cache between cases. */
export function _clearRetrievalV2SettingCache(): void {
  cache.clear();
}
