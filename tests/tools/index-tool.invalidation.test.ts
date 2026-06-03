import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  _clearIndexCache,
  invalidateIndexForWorkspace,
  disposeWorkspaceDebouncer,
} from "../../src/tools/index-tool.js";
import type { FileMeta, StorageBackend } from "../../src/utils/storage.js";

function makeBackend(overrides: Partial<StorageBackend> = {}): StorageBackend {
  const base: Partial<StorageBackend> = {
    readFile: vi.fn(async () => ""),
    writeFile: vi.fn(async () => undefined),
    listFiles: vi.fn(async () => []),
    exists: vi.fn(async () => false),
    mkdir: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: 0, modifiedAt: new Date() })),
    recentFiles: vi.fn(async () => []),
    listChanged: vi.fn(async () => ({ files: [], next: null })),
    batchUpdateCardinalities: vi.fn(async () => undefined),
    batchUpdateTokens: vi.fn(async () => undefined),
    // The flush warms the V2 retrieval index off a SEPARATE uncapped query
    // (listFileTokensMeta), NOT loadIndexData's listFilesMeta pass. These tests
    // count listFiles as the index.md synthesis-pass proxy; the warm must not
    // inflate it. Retrieval index CONTENT is covered in retrieval-index-coverage.
    listFileTokensMeta: vi.fn(async () => []),
  };
  const merged = { ...base, ...overrides } as StorageBackend;
  // Default listFilesMeta delegates to listFiles + readFile so existing
  // tests (which only stub those) still drive flushes through loadIndexData.
  if (!overrides.listFilesMeta) {
    merged.listFilesMeta = vi.fn(async () => {
      const paths = await merged.listFiles();
      return paths.map((p): FileMeta => ({ path: p, cardinality: null }));
    });
  }
  return merged;
}

describe("invalidateIndexForWorkspace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    // Clean up any lingering debouncers from test workspaces
    for (const ws of ["ws-a", "ws-b", "ws-c"]) {
      disposeWorkspaceDebouncer(ws);
    }
  });

  it("cache miss after upsert event (debounce flushed)", async () => {
    const backend = makeBackend({
      listFiles: vi.fn(async () => ["notes/foo.md"]),
    });

    // Invalidate with a 10ms debounce
    invalidateIndexForWorkspace("ws-a", backend, 10);

    // Advance timers to flush the debounce
    await vi.runAllTimersAsync();

    // listFiles called during flush synthesis
    expect(backend.listFiles).toHaveBeenCalled();
  });

  it("back-to-back upserts within debounce window collapse to single regeneration", async () => {
    const backend = makeBackend({
      listFiles: vi.fn(async () => ["notes/foo.md"]),
    });

    // Fire 3 invalidations within the debounce window
    invalidateIndexForWorkspace("ws-a", backend, 50);
    invalidateIndexForWorkspace("ws-a", backend, 50);
    invalidateIndexForWorkspace("ws-a", backend, 50);

    await vi.runAllTimersAsync();

    // Only one synthesis run despite 3 invalidations
    expect(backend.listFiles).toHaveBeenCalledTimes(1);
  });

  it("per-workspace isolation: workspace A upsert does NOT trigger workspace B synthesis", async () => {
    const backendA = makeBackend({
      listFiles: vi.fn(async () => ["a/file.md"]),
    });
    const backendB = makeBackend({
      listFiles: vi.fn(async () => ["b/file.md"]),
    });

    invalidateIndexForWorkspace("ws-a", backendA, 10);

    await vi.runAllTimersAsync();

    expect(backendA.listFiles).toHaveBeenCalled();
    expect(backendB.listFiles).not.toHaveBeenCalled();
  });

  it("cache is populated after flush fires", async () => {
    let listCallCount = 0;
    const backend = makeBackend({
      listFiles: vi.fn(async () => {
        listCallCount++;
        return ["notes/foo.md"];
      }),
    });

    // Flush the debounce — this synthesizes and populates the cache
    invalidateIndexForWorkspace("ws-c", backend, 0);
    await vi.runAllTimersAsync();

    expect(listCallCount).toBe(1);

    // A second flush should still synthesize (each flush evicts + repopulates)
    _clearIndexCache(backend);
    invalidateIndexForWorkspace("ws-c", backend, 0);
    await vi.runAllTimersAsync();

    expect(listCallCount).toBe(2);
  });
});
