import { describe, it, expect, vi, beforeEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────
// Option B — per-workspace V2 opt-in read from workspaces.settings.retrieval_v2,
// cached 5 min (decision 2026-06-03-pass-3-cohort-flag-rollout). Pins: true only
// when the column is literally `true`; cached (a 2nd read is a cache hit, no DB);
// fail-safe to FALSE on any error (a flag read must never promote to V2 by
// accident); invalidate drops the entry so a flip is visible immediately.
// ─────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => {
  const maybeSingle = vi.fn();
  // .from(...).select(...).eq(...).maybeSingle()
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    maybeSingle,
  };
  const from = vi.fn(() => chain);
  return { maybeSingle, from };
});

vi.mock("../../src/api/supabase.js", () => ({
  supabaseService: vi.fn(() => ({ from: h.from })),
}));

import {
  retrievalV2Setting,
  invalidateRetrievalV2Setting,
  _clearRetrievalV2SettingCache,
} from "../../src/utils/workspace-flags.js";

beforeEach(() => {
  _clearRetrievalV2SettingCache();
  h.maybeSingle.mockReset();
  h.from.mockClear();
});

describe("retrievalV2Setting", () => {
  it("is true only when settings.retrieval_v2 === true", async () => {
    h.maybeSingle.mockResolvedValueOnce({
      data: { settings: { retrieval_v2: true } },
      error: null,
    });
    expect(await retrievalV2Setting("ws-on")).toBe(true);
  });

  it("is false when the flag is absent / falsy / a non-true value", async () => {
    for (const settings of [
      {},
      { retrieval_v2: false },
      { retrieval_v2: "true" }, // string, not boolean — must NOT promote
      { retrieval_v2: 1 },
      null,
    ]) {
      _clearRetrievalV2SettingCache();
      h.maybeSingle.mockResolvedValueOnce({ data: { settings }, error: null });
      expect(await retrievalV2Setting("ws")).toBe(false);
    }
  });

  it("caches — a second read for the same workspace does NOT hit the DB", async () => {
    h.maybeSingle.mockResolvedValueOnce({
      data: { settings: { retrieval_v2: true } },
      error: null,
    });
    expect(await retrievalV2Setting("ws-cache")).toBe(true);
    expect(await retrievalV2Setting("ws-cache")).toBe(true);
    expect(h.from).toHaveBeenCalledTimes(1); // one query, then served from cache
  });

  it("fail-safe: a DB error resolves to FALSE (never throws, never promotes)", async () => {
    h.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: "boom" },
    });
    expect(await retrievalV2Setting("ws-err")).toBe(false);
  });

  it("fail-safe: a thrown/rejected query resolves to FALSE", async () => {
    h.maybeSingle.mockRejectedValueOnce(new Error("network down"));
    expect(await retrievalV2Setting("ws-throw")).toBe(false);
  });

  it("invalidate drops the cache so a flip is seen on the next read", async () => {
    h.maybeSingle.mockResolvedValueOnce({
      data: { settings: { retrieval_v2: false } },
      error: null,
    });
    expect(await retrievalV2Setting("ws-flip")).toBe(false);

    invalidateRetrievalV2Setting("ws-flip");
    h.maybeSingle.mockResolvedValueOnce({
      data: { settings: { retrieval_v2: true } },
      error: null,
    });
    expect(await retrievalV2Setting("ws-flip")).toBe(true); // re-read picks up the flip
    expect(h.from).toHaveBeenCalledTimes(2);
  });
});
