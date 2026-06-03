/**
 * delete() and move() must invalidate the index/retrieval caches — the same way
 * writeFile() does. Before this fix, only writeFile invalidated, so the V2
 * retrieval index (cached, keyed by backend) kept serving a deleted/moved note
 * as a GHOST result for up to the backend TTL (~5 min). V1 read listFiles live
 * and never had this; V2 reads the cache. This also fixes a pre-existing
 * index.md staleness on delete/move (garden_index could show a deleted note).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Partial mock: keep every real export, spy only on invalidateIndexForWorkspace.
vi.mock("../../src/tools/index-tool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/index-tool.js")>()),
  invalidateIndexForWorkspace: vi.fn(),
}));

import { invalidateIndexForWorkspace } from "../../src/tools/index-tool.js";
import { SupabaseEncryptedMirrorBackend } from "../../src/utils/supabase-mirror.js";

const DUMMY_DEK = Buffer.alloc(32, 0x42);
const WS_ID = "ws-test-invalidation-0000";

// Minimal chainable mock for delete()/move(): update(...).eq().eq().is() awaited
// to { count: 1, error: null } (count=1 → no NotFoundError).
function makeMock() {
  const chain: Record<string, unknown> = {};
  const ret = () => chain;
  chain.update = vi.fn(ret);
  chain.eq = vi.fn(ret);
  chain.is = vi.fn(ret);
  chain.then = (resolve: (v: { count: number; error: null }) => unknown) =>
    Promise.resolve({ count: 1, error: null }).then(resolve);
  return { from: vi.fn(() => chain), storage: { from: () => ({}) } };
}

describe("delete()/move() cache invalidation", () => {
  beforeEach(() => {
    vi.mocked(invalidateIndexForWorkspace).mockClear();
  });

  it("delete() invalidates the index + retrieval cache", async () => {
    const backend = new SupabaseEncryptedMirrorBackend(
      makeMock() as never,
      WS_ID,
      DUMMY_DEK,
    );
    await backend.delete("notes/foo.md");
    expect(invalidateIndexForWorkspace).toHaveBeenCalledWith(WS_ID, backend);
  });

  it("move() invalidates the index + retrieval cache", async () => {
    const backend = new SupabaseEncryptedMirrorBackend(
      makeMock() as never,
      WS_ID,
      DUMMY_DEK,
    );
    await backend.move("notes/old.md", "notes/new.md");
    expect(invalidateIndexForWorkspace).toHaveBeenCalledWith(WS_ID, backend);
  });
});
