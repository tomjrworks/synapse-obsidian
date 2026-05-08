import { LRUCache } from "lru-cache";

// Tool-level rate limiting. Keyed by (kind, workspaceId, tool). Separate
// buckets for writes vs reads — write tools bill per-call (Storage write,
// encrypt); reads are mostly cache-hit. Caps sized at audit H11.
//
// Uses a sliding window: store timestamps of the last `max` calls; a new
// call is allowed if the oldest timestamp is outside the window.

interface ToolLimitConfig {
  max: number;
  windowMs: number;
}

const WRITE_LIMIT: ToolLimitConfig = { max: 30, windowMs: 60_000 };
const READ_LIMIT: ToolLimitConfig = { max: 120, windowMs: 60_000 };

const buckets = new LRUCache<string, number[]>({
  max: 10_000,
  ttl: 5 * 60_000,
});

export type ToolKind = "read" | "write";

/**
 * Check whether a tool call is within its per-workspace rate limit.
 * Returns null on allow; returns an error string on deny.
 * Rollback gate: TAPROOT_DISABLE_TOOL_RATE_LIMIT=1 bypasses all limits.
 */
export function checkToolRateLimit(
  workspaceId: string,
  tool: string,
  kind: ToolKind,
): string | null {
  if (process.env.TAPROOT_DISABLE_TOOL_RATE_LIMIT === "1") return null;
  const cfg = kind === "write" ? WRITE_LIMIT : READ_LIMIT;
  const key = `${kind}:${workspaceId}:${tool}`;
  const now = Date.now();
  const stamps = (buckets.get(key) ?? []).filter((t) => now - t < cfg.windowMs);
  if (stamps.length >= cfg.max) {
    const waitSec = Math.ceil((cfg.windowMs - (now - stamps[0])) / 1000);
    return `Rate limit: ${tool} is capped at ${cfg.max} calls per ${cfg.windowMs / 1000}s per workspace. Try again in ${waitSec}s.`;
  }
  stamps.push(now);
  buckets.set(key, stamps);
  return null;
}

export function rateLimitToolError(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}
