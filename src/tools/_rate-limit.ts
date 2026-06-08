import { randomUUID } from "crypto";
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

// M2 (2026-06-08 security-audit fast-follow): taproot_prune gets a much
// tighter cap. It decrypt-reads EVERY file per call with NO bound (audit H2 —
// the unbounded scan, deferred to Pass 7), so the generic READ_LIMIT(120) lets
// a runaway agent fire 120 full-vault decrypts/min per workspace. This restores
// the dedicated throttle that commit 24f8abd had before the withTelemetry
// refactor dropped it. prune is human-triggered (a "health check", a handful/
// day), so 5/min is invisible to real users.
//
// NOTE: taproot_harvest is deliberately NOT here. Despite also scanning the
// vault, harvest is the PRIMARY retrieval tool (hot read path, called per
// question) and is already bounded by scanVaultBodies (cap 300 + 15s budget,
// the bac2d1b fix) — its per-call cost is capped, so it rightly stays on
// READ_LIMIT(120). Capping it would throttle the core answer path.
//
// Keyed by tool name (the bucket key already includes the tool), independent
// of read/write kind.
const EXPENSIVE_LIMIT: ToolLimitConfig = { max: 5, windowMs: 60_000 };
const EXPENSIVE_TOOLS = new Set(["taproot_prune"]);

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
  const cfg = EXPENSIVE_TOOLS.has(tool)
    ? EXPENSIVE_LIMIT
    : kind === "write"
      ? WRITE_LIMIT
      : READ_LIMIT;
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

export function respondToolError(
  code: string,
  err: unknown,
): { isError: true; content: [{ type: "text"; text: string }] } {
  const requestId = randomUUID();
  console.error(`[tool_error] code=${code} request_id=${requestId}`, err);
  return {
    isError: true as const,
    content: [
      { type: "text" as const, text: `${code} [request_id: ${requestId}]` },
    ],
  };
}
