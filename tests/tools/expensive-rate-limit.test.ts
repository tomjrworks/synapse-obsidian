import { describe, it, expect, beforeEach, vi } from "vitest";
import { checkToolRateLimit } from "../../src/tools/_rate-limit.js";

// ---------------------------------------------------------------------------
// M2 (2026-06-08 security-audit fast-follow): whole-vault scan tools
// (taproot_prune, taproot_harvest) must ride a tighter "expensive" cap, NOT
// the generic 120/min READ_LIMIT.
//
// Regression context: the dedicated "1 call / 60s / workspace" prune throttle
// (commit 24f8abd) was silently dropped when rate-limiting moved into
// withTelemetry, which applies READ_LIMIT(120). Combined with prune's
// unbounded full-vault decrypt (audit H2 → Pass 7), 120 decrypts/min is a
// real authed availability vector. These evals pin the restored cap.
//
// EXPECTATION: expensive tools cap at EXPENSIVE_LIMIT.max (5); a normal read
// tool stays at READ_LIMIT (120). Each test uses a unique workspaceId so the
// module-level LRU bucket state is fresh.
// ---------------------------------------------------------------------------

const EXPENSIVE_CAP = 5; // EXPENSIVE_LIMIT.max
const READ_CAP = 120; // READ_LIMIT.max

describe("expensive-tool rate cap (M2)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("taproot_prune is denied after the expensive cap, well below the read cap", () => {
    const ws = `ws-prune-${Date.now()}-${Math.random()}`;
    // First EXPENSIVE_CAP calls allowed.
    for (let i = 0; i < EXPENSIVE_CAP; i++) {
      expect(checkToolRateLimit(ws, "taproot_prune", "read")).toBeNull();
    }
    // The very next call (cap+1, = 6th) must be denied — under the old
    // READ_LIMIT(120) this would still be allowed (the RED assertion).
    const denied = checkToolRateLimit(ws, "taproot_prune", "read");
    expect(denied).not.toBeNull();
    expect(denied).toContain("taproot_prune");
    expect(denied).toContain(`${EXPENSIVE_CAP} calls`);
  });

  it("taproot_harvest is deliberately NOT expensive-capped — it's the bounded hot read path", () => {
    // harvest scans the vault too, but is bounded (scanVaultBodies cap 300 +
    // 15s budget) and is the primary per-question retrieval tool. It rightly
    // stays on READ_LIMIT(120), not the prune cap. Allowed well past 5.
    const ws = `ws-harvest-${Date.now()}-${Math.random()}`;
    for (let i = 0; i <= EXPENSIVE_CAP + 5; i++) {
      expect(checkToolRateLimit(ws, "taproot_harvest", "read")).toBeNull();
    }
  });

  it("a normal read tool is unaffected — still allowed past the expensive cap", () => {
    const ws = `ws-read-${Date.now()}-${Math.random()}`;
    // Call a non-expensive read tool EXPENSIVE_CAP+1 times; all allowed.
    for (let i = 0; i <= EXPENSIVE_CAP; i++) {
      expect(checkToolRateLimit(ws, "garden_read", "read")).toBeNull();
    }
    // And it keeps going up to (but not past) the read cap.
    for (let i = EXPENSIVE_CAP + 1; i < READ_CAP; i++) {
      expect(checkToolRateLimit(ws, "garden_read", "read")).toBeNull();
    }
    expect(checkToolRateLimit(ws, "garden_read", "read")).not.toBeNull();
  });

  it("the kill switch bypasses the expensive cap too", () => {
    const ws = `ws-kill-${Date.now()}-${Math.random()}`;
    vi.stubEnv("TAPROOT_DISABLE_TOOL_RATE_LIMIT", "1");
    for (let i = 0; i < EXPENSIVE_CAP + 3; i++) {
      expect(checkToolRateLimit(ws, "taproot_prune", "read")).toBeNull();
    }
  });
});
