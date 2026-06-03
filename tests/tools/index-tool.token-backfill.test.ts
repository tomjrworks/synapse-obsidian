import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  invalidateIndexForWorkspace,
  disposeWorkspaceDebouncer,
} from "../../src/tools/index-tool.js";
import type { FileMeta, StorageBackend } from "../../src/utils/storage.js";
import type { FileTokens } from "../../src/utils/frontmatter.js";

// ─────────────────────────────────────────────────────────────────────────
// AUDIT B1 regression. The Pass 3 eval harness drives the tools through an
// in-memory mock backend that bypasses loadIndexData's production backfill
// predicate entirely — so it CANNOT catch B1. This test exercises that exact
// predicate.
//
// B1: loadIndexData's backfill loop originally gated file reads on
// `cardinality === null`. On Tom's vault cardinality is already fully
// backfilled, so the loop read nothing → the new extracted_tokens column would
// NEVER populate for untouched notes → flipping TAPROOT_RETRIEVAL_V2 would serve
// degraded recall. The fix widens the predicate to
// `cardinality === null || tokens === null` and persists tokens in the loop.
// ─────────────────────────────────────────────────────────────────────────

function makeBackend(
  meta: FileMeta[],
  files: Record<string, string>,
): {
  backend: StorageBackend;
  tokenSpy: ReturnType<typeof vi.fn>;
  cardSpy: ReturnType<typeof vi.fn>;
} {
  const tokenSpy = vi.fn(async () => undefined);
  const cardSpy = vi.fn(async () => undefined);
  const backend = {
    // Forgiving: returns "" for unknown paths (e.g. ignore-pattern reads) so
    // loadIgnorePatterns/loadIndexData never throw and the flush completes.
    readFile: vi.fn(async (p: string) => files[p] ?? ""),
    writeFile: vi.fn(async () => undefined),
    listFiles: vi.fn(async () => meta.map((m) => m.path)),
    exists: vi.fn(async () => false),
    mkdir: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: 0, modifiedAt: new Date() })),
    recentFiles: vi.fn(async () => []),
    listChanged: vi.fn(async () => ({
      files: [],
      next: null,
      pendingCount: 0,
    })),
    getCursorHead: vi.fn(async () => null),
    getPendingCount: vi.fn(async () => 0),
    listFilesMeta: vi.fn(async () => meta),
    batchUpdateCardinalities: cardSpy,
    batchUpdateTokens: tokenSpy,
  } as unknown as StorageBackend;
  return { backend, tokenSpy, cardSpy };
}

const CARD = { tags: ["it"], status: "active", custom: {} };
const POPULATED: FileTokens = {
  frontmatter: ["done"],
  body: ["body"],
  identifiers: [],
};

describe("loadIndexData token backfill (AUDIT B1 predicate)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    disposeWorkspaceDebouncer("ws-b1");
  });

  it("backfills a cardinality-PRESENT / tokens-NULL row (the exact B1 case)", async () => {
    const meta: FileMeta[] = [
      // Tom's-vault shape: cardinality already backfilled, tokens still null.
      {
        path: "school/is-7011-it-management/m1.md",
        cardinality: CARD,
        tokens: null,
      },
      // Both present — must NOT be re-read or re-written.
      { path: "decisions/done.md", cardinality: CARD, tokens: POPULATED },
    ];
    const files = {
      "school/is-7011-it-management/m1.md":
        "# IS 7011 IT management\n\ncompetitive advantage of information systems",
      "decisions/done.md": "# Done\n\nbody",
    };
    const { backend, tokenSpy, cardSpy } = makeBackend(meta, files);

    invalidateIndexForWorkspace("ws-b1", backend, 0);
    await vi.runAllTimersAsync();

    // Tokens written for the null-token row only.
    expect(tokenSpy).toHaveBeenCalledTimes(1);
    const tokenMap = tokenSpy.mock.calls[0][0] as Map<string, FileTokens>;
    expect(tokenMap.has("school/is-7011-it-management/m1.md")).toBe(true);
    expect(tokenMap.has("decisions/done.md")).toBe(false);

    // The backfilled tokens carry the identifier 7011 + a body token.
    const t = tokenMap.get("school/is-7011-it-management/m1.md")!;
    expect(t.identifiers).toContain("7011");
    expect(t.body).toContain("competitive");

    // Cardinality is NOT rewritten — both rows already had it (idempotent).
    const cardMap = cardSpy.mock.calls[0]?.[0] as
      | Map<string, unknown>
      | undefined;
    expect(cardMap?.has("school/is-7011-it-management/m1.md") ?? false).toBe(
      false,
    );
  });

  it("does NOT touch the backfill path when every row has cardinality AND tokens", async () => {
    const meta: FileMeta[] = [
      { path: "a.md", cardinality: CARD, tokens: POPULATED },
      { path: "b.md", cardinality: CARD, tokens: POPULATED },
    ];
    const { backend, tokenSpy, cardSpy } = makeBackend(meta, {
      "a.md": "x",
      "b.md": "x",
    });

    invalidateIndexForWorkspace("ws-b1", backend, 0);
    await vi.runAllTimersAsync();

    expect(tokenSpy).not.toHaveBeenCalled();
    expect(cardSpy).not.toHaveBeenCalled();
  });

  it("still backfills cardinality for a cardinality-NULL row (existing behavior preserved)", async () => {
    const meta: FileMeta[] = [
      { path: "notes/fresh.md", cardinality: null, tokens: null },
    ];
    const { backend, tokenSpy, cardSpy } = makeBackend(meta, {
      "notes/fresh.md": "---\ntags: [ai]\n---\n# Fresh\n\nbody text here",
    });

    invalidateIndexForWorkspace("ws-b1", backend, 0);
    await vi.runAllTimersAsync();

    const cardMap = cardSpy.mock.calls[0][0] as Map<string, unknown>;
    expect(cardMap.has("notes/fresh.md")).toBe(true);
    const tokenMap = tokenSpy.mock.calls[0][0] as Map<string, FileTokens>;
    expect(tokenMap.has("notes/fresh.md")).toBe(true);
  });
});
