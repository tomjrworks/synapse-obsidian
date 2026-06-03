import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getRetrievalIndex,
  scoreQuery,
  backfillNullTokens,
  _clearRetrievalIndexCache,
} from "../../src/utils/retrieval-index.js";
import type { FileMeta, StorageBackend } from "../../src/utils/storage.js";
import type { FileTokens } from "../../src/utils/frontmatter.js";

// ─────────────────────────────────────────────────────────────────────────
// Path B — full-vault retrieval coverage (the 1000-row cap blocker the fixture
// evals could NOT catch). The Supabase `listFilesMeta` SELECT caps at 1000 rows
// (shared with index.md, which WANTS the cap). The V2 retrieval index must NOT
// inherit that cap — it reads via the dedicated, uncapped `listFileTokensMeta`,
// so a file at row 1001+ on a 1432-file vault is still reachable.
// ─────────────────────────────────────────────────────────────────────────

const EMPTY: FileTokens = {
  frontmatter: [],
  body: ["filler"],
  identifiers: [],
};
const TARGET = "school/is-7011-it-management/m1432.md";
const TARGET_TOKENS: FileTokens = {
  frontmatter: [],
  body: ["zzzuniquebodytoken"],
  identifiers: ["7011"],
};

// 1000 capped rows that do NOT include the target, + an uncapped reader that
// returns those 1000 PLUS the target at position 1001 (beyond the cap).
function makeCappedBackend(): StorageBackend {
  const capped: FileMeta[] = Array.from({ length: 1000 }, (_, i) => ({
    path: `daily/filler-${i}.md`,
    cardinality: null,
    tokens: EMPTY,
  }));
  const full: FileMeta[] = [
    ...capped,
    { path: TARGET, cardinality: null, tokens: TARGET_TOKENS },
  ];
  return {
    readFile: vi.fn(async () => ""),
    listFilesMeta: vi.fn(async () => capped), // prod cap: 1000, target absent
    listFileTokensMeta: vi.fn(async () => full), // uncapped: target present
    batchUpdateTokens: vi.fn(async () => undefined),
  } as unknown as StorageBackend;
}

describe("getRetrievalIndex — uncapped coverage (Path B)", () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => vi.unstubAllEnvs());

  it("indexes a file beyond the 1000-row listFilesMeta cap", async () => {
    const backend = makeCappedBackend();
    _clearRetrievalIndexCache(backend);
    const index = await getRetrievalIndex(backend);
    // The target is row 1001 — only reachable via the uncapped reader.
    const hits = scoreQuery(index, "zzzuniquebodytoken");
    expect(hits.map((h) => h.path)).toContain(TARGET);
    // And it must have used the dedicated uncapped reader, not listFilesMeta.
    expect(backend.listFileTokensMeta).toHaveBeenCalled();
  });
});

describe("backfillNullTokens — full-vault token population", () => {
  it("reads + writes tokens for null-token rows, skips populated ones", async () => {
    const spy = vi.fn(async () => undefined);
    const backend = {
      readFile: vi.fn(async (p: string) =>
        p === "notes/cold-tail.md"
          ? "# Cold tail\n\ncompetitive advantage is7011 stuff"
          : "",
      ),
      batchUpdateTokens: spy,
    } as unknown as StorageBackend;

    await backfillNullTokens(backend, ["notes/cold-tail.md"]);

    expect(spy).toHaveBeenCalledTimes(1);
    const written = spy.mock.calls[0][0] as Map<string, FileTokens>;
    expect(written.has("notes/cold-tail.md")).toBe(true);
    expect(written.get("notes/cold-tail.md")!.identifiers).toContain("7011");
  });

  it("no-ops on an empty null-path list (no round trip)", async () => {
    const spy = vi.fn(async () => undefined);
    const backend = {
      readFile: vi.fn(async () => ""),
      batchUpdateTokens: spy,
    } as unknown as StorageBackend;
    await backfillNullTokens(backend, []);
    expect(spy).not.toHaveBeenCalled();
  });
});
