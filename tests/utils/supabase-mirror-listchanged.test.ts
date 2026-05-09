/**
 * Unit tests for SupabaseEncryptedMirrorBackend.listChanged (parallelism +
 * error handling) and getCursorHead (cursor seeding).
 *
 * Uses a hand-rolled Supabase client mock so no network calls are made.
 * The mock supports the chainable query-builder pattern that supabase-js uses.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { SupabaseEncryptedMirrorBackend } from "../../src/utils/supabase-mirror.js";

// ---------------------------------------------------------------------------
// Minimal Supabase client mock
// ---------------------------------------------------------------------------

type DownloadResult = {
  data: Blob | null;
  error: { message: string; statusCode?: string } | null;
};

interface MockRow {
  id: string;
  path: string;
  size_bytes: number;
  modified_at: string;
  deleted_at: string | null;
  storage_object: string;
}

/**
 * Build a chainable query builder that:
 *   - resolves to `awaitResult` when awaited directly (for `await query`)
 *   - resolves to `maybeSingleResult` when `.maybeSingle()` is called
 */
function makeBuilder(
  awaitResult: { data: unknown; error: null; count?: number | null },
  maybeSingleResult: { data: unknown; error: null } = {
    data: null,
    error: null,
  },
) {
  const b: Record<string, unknown> = {
    select: () => b,
    eq: () => b,
    or: () => b,
    is: () => b,
    order: () => b,
    limit: () => b,
    maybeSingle: () => Promise.resolve(maybeSingleResult),
    // Make the builder itself awaitable (supabase-js QueryBuilder is a thenable)
    then: (
      resolve: (v: {
        data: unknown;
        error: null;
        count?: number | null;
      }) => unknown,
      reject: (e: unknown) => unknown,
    ) => Promise.resolve(awaitResult).then(resolve, reject),
  };
  return b;
}

/**
 * Build a mock Supabase client.
 *
 * `listRows` — rows returned by the main vault_files select (listChanged query)
 * `downloadFn` — called per storage_object; returns the download result
 * `headRow` — row returned by getCursorHead's maybeSingle()
 */
function makeMockSupabase({
  listRows = [] as MockRow[],
  downloadFn = vi
    .fn()
    .mockResolvedValue({ data: new Blob(["enc"]), error: null }),
  headRow = null as { modified_at: string; id: string } | null,
} = {}) {
  const listBuilder = makeBuilder({ data: listRows, error: null, count: null });
  const countBuilder = makeBuilder({ data: null, error: null, count: 0 });
  const headBuilder = makeBuilder(
    { data: headRow, error: null },
    { data: headRow, error: null },
  );

  let fromCallCount = 0;
  const from = vi.fn().mockImplementation(() => {
    fromCallCount++;
    // First call: main select (listChanged main query or getCursorHead)
    // Second call: count query in listChanged
    // getCursorHead only calls from() once → use headBuilder when maybeSingle is expected
    // We return headBuilder for getCursorHead by checking if headRow is being tested
    if (fromCallCount === 1 && headRow !== undefined) {
      // Could be listChanged main query OR getCursorHead
      // Distinguish: listChanged tests set listRows; getCursorHead tests leave listRows=[]
      return listRows.length > 0 ? listBuilder : headBuilder;
    }
    return fromCallCount === 1 ? listBuilder : countBuilder;
  });

  return {
    from,
    storage: {
      from: () => ({ download: downloadFn }),
    },
    _downloadFn: downloadFn,
  };
}

// Minimal AES-256-GCM key (32 bytes) for constructing the backend.
// decryptBlob will fail on synthetic data — tests that check content use a
// mock that skips decryption by having download return null/error.
const DUMMY_DEK = Buffer.alloc(32, 0x42);
const WS_ID = "ws-test-00000000";

// ---------------------------------------------------------------------------
// Tests: listChanged parallelism + error handling
// ---------------------------------------------------------------------------

describe("listChanged — parallelism", () => {
  afterEach(() => {
    delete process.env.PULL_PARALLELISM;
  });

  it("processes all deleted rows without calling download", async () => {
    const rows: MockRow[] = Array.from({ length: 5 }, (_, i) => ({
      id: `id-${i}`,
      path: `file${i}.md`,
      size_bytes: 10,
      modified_at: "2026-05-09T00:00:00Z",
      deleted_at: "2026-05-09T00:00:01Z",
      storage_object: `${WS_ID}/id-${i}`,
    }));

    const downloadFn = vi.fn();
    const sb = makeMockSupabase({ listRows: rows, downloadFn });
    const backend = new SupabaseEncryptedMirrorBackend(
      sb as never,
      WS_ID,
      DUMMY_DEK,
    );

    const result = await backend.listChanged(null, 500);
    expect(result.files.length).toBe(5);
    expect(result.files.every((f) => f.deleted)).toBe(true);
    expect(downloadFn).not.toHaveBeenCalled();
  });

  it("skips rows whose download returns a transient 503 error", async () => {
    const rows: MockRow[] = [
      {
        id: "id-good",
        path: "good.md",
        size_bytes: 10,
        modified_at: "2026-05-09T00:00:00Z",
        deleted_at: null,
        storage_object: `${WS_ID}/id-good`,
      },
      {
        id: "id-bad",
        path: "bad.md",
        size_bytes: 10,
        modified_at: "2026-05-09T00:00:01Z",
        deleted_at: null,
        storage_object: `${WS_ID}/id-bad`,
      },
    ];

    const downloadFn = vi.fn().mockImplementation(async (obj: string) => {
      if (obj.includes("id-bad")) {
        return {
          data: null,
          error: { message: "Service Unavailable", statusCode: "503" },
        };
      }
      // good.md returns a blob — but decryptBlob will throw on dummy data.
      // Return error with a 404 to trigger deleted marking instead
      // (we just want to confirm bad.md is skipped not marked deleted).
      return { data: null, error: { message: "not found", statusCode: "404" } };
    });

    const sb = makeMockSupabase({ listRows: rows, downloadFn });
    const backend = new SupabaseEncryptedMirrorBackend(
      sb as never,
      WS_ID,
      DUMMY_DEK,
    );

    const result = await backend.listChanged(null, 500);
    // bad.md (503) → skipped (not in files at all)
    // good.md (404) → marked deleted
    const paths = result.files.map((f) => f.path);
    expect(paths).not.toContain("bad.md");
    // good.md appears as deleted (404 → tombstone)
    const goodEntry = result.files.find((f) => f.path === "good.md");
    expect(goodEntry?.deleted).toBe(true);
  });

  it("marks rows deleted when download returns 404", async () => {
    const rows: MockRow[] = [
      {
        id: "id-missing",
        path: "missing.md",
        size_bytes: 10,
        modified_at: "2026-05-09T00:00:00Z",
        deleted_at: null,
        storage_object: `${WS_ID}/id-missing`,
      },
    ];

    const downloadFn = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "Object Not Found", statusCode: "404" },
    });

    const sb = makeMockSupabase({ listRows: rows, downloadFn });
    const backend = new SupabaseEncryptedMirrorBackend(
      sb as never,
      WS_ID,
      DUMMY_DEK,
    );

    const result = await backend.listChanged(null, 500);
    expect(result.files.length).toBe(1);
    expect(result.files[0].deleted).toBe(true);
    expect(result.files[0].path).toBe("missing.md");
  });

  it("skips rows whose download times out (statusCode 504)", async () => {
    const rows: MockRow[] = [
      {
        id: "id-slow",
        path: "slow.md",
        size_bytes: 10,
        modified_at: "2026-05-09T00:00:00Z",
        deleted_at: null,
        storage_object: `${WS_ID}/id-slow`,
      },
    ];

    // Simulate timeout: same shape as the Promise.race timeout arm (statusCode 504
    // makes it detectable by isTransient, so withRetry retries then skips).
    const downloadFn = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "blob download timeout after 10s", statusCode: "504" },
    });

    const sb = makeMockSupabase({ listRows: rows, downloadFn });
    const backend = new SupabaseEncryptedMirrorBackend(
      sb as never,
      WS_ID,
      DUMMY_DEK,
    );

    const result = await backend.listChanged(null, 500);
    // timeout → transient → skipped (not in files, not marked deleted)
    expect(result.files.length).toBe(0);
  });

  it("PULL_PARALLELISM=1 still processes all rows", async () => {
    process.env.PULL_PARALLELISM = "1";
    const rows: MockRow[] = Array.from({ length: 6 }, (_, i) => ({
      id: `id-${i}`,
      path: `file${i}.md`,
      size_bytes: 10,
      modified_at: "2026-05-09T00:00:00Z",
      deleted_at: "2026-05-09T00:00:01Z",
      storage_object: `${WS_ID}/id-${i}`,
    }));

    const downloadFn = vi.fn();
    const sb = makeMockSupabase({ listRows: rows, downloadFn });
    const backend = new SupabaseEncryptedMirrorBackend(
      sb as never,
      WS_ID,
      DUMMY_DEK,
    );

    const result = await backend.listChanged(null, 500);
    expect(result.files.length).toBe(6);
    expect(downloadFn).not.toHaveBeenCalled(); // all deleted, no downloads
  });
});

// ---------------------------------------------------------------------------
// Tests: getCursorHead
// ---------------------------------------------------------------------------

describe("getCursorHead", () => {
  it("returns null for an empty workspace", async () => {
    // Build a mock where maybeSingle returns null
    const builder = makeBuilder(
      { data: null, error: null },
      { data: null, error: null },
    );
    const sb = {
      from: vi.fn().mockReturnValue(builder),
      storage: { from: () => ({ download: vi.fn() }) },
    };
    const backend = new SupabaseEncryptedMirrorBackend(
      sb as never,
      WS_ID,
      DUMMY_DEK,
    );
    const head = await backend.getCursorHead();
    expect(head).toBeNull();
  });

  it("returns the highest (modified_at, id) tuple", async () => {
    const row = {
      modified_at: "2026-05-09T15:00:00+00:00",
      id: "bbbbbbbb-0000-0000-0000-000000000002",
    };
    const builder = makeBuilder(
      { data: row, error: null },
      { data: row, error: null },
    );
    const sb = {
      from: vi.fn().mockReturnValue(builder),
      storage: { from: () => ({ download: vi.fn() }) },
    };
    const backend = new SupabaseEncryptedMirrorBackend(
      sb as never,
      WS_ID,
      DUMMY_DEK,
    );
    const head = await backend.getCursorHead();
    expect(head).not.toBeNull();
    // +00:00 should be normalized to Z
    expect(head!.modifiedAt).toBe("2026-05-09T15:00:00Z");
    expect(head!.id).toBe(row.id);
  });

  it("preserves already-Z timestamps without double-normalizing", async () => {
    const row = {
      modified_at: "2026-05-09T15:00:00Z",
      id: "cccccccc-0000-0000-0000-000000000003",
    };
    const builder = makeBuilder(
      { data: row, error: null },
      { data: row, error: null },
    );
    const sb = {
      from: vi.fn().mockReturnValue(builder),
      storage: { from: () => ({ download: vi.fn() }) },
    };
    const backend = new SupabaseEncryptedMirrorBackend(
      sb as never,
      WS_ID,
      DUMMY_DEK,
    );
    const head = await backend.getCursorHead();
    expect(head!.modifiedAt).toBe("2026-05-09T15:00:00Z");
  });
});
