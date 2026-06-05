import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend, FileMeta } from "../../src/utils/storage.js";
import {
  extractCardinality,
  extractTokens,
} from "../../src/utils/frontmatter.js";
import { extractOutlinks } from "../../src/utils/outlinks.js";
import {
  PASS4B_BACKLINKS_CORPUS,
  TARGET_M1,
  TARGET_M1_BASENAME,
  COURSE_INDEX,
  MODULE3,
  RECAP,
  ORPHAN,
  BL7_FENCED_SOURCE,
  BL7_TARGET,
} from "../fixtures/retrieval-pass4b-backlinks/corpus.js";

// ─────────────────────────────────────────────────────────────────────────
// Pass 4b — garden_backlinks v2 (spec §1). Precision = 1.000 is the hard,
// non-negotiable gate: a backlinks tool that invents edges is worse than none.
//
// v2 reads the STORED extracted_outlinks column (listFileOutlinksMeta) — NOT a
// per-call full-vault body scan (the bac2d1b 4–13 min prod-hang on the
// encrypted mirror). BL6 is the anti-hang regression bar: the handler must not
// readFile every note. The corpus backend below simulates the stored column by
// running extractOutlinks over each note (exactly what the write hook persists).
//
// RED-eval-first: until the handler is registered, handlers.get(...) is
// undefined and callBacklinks throws (the literal failing-eval-first state).
// ─────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => {
  const inserted: any[] = [];
  const fromMock = vi.fn((_t: string) => ({
    insert: (row: unknown) => {
      inserted.push(row);
      return Promise.resolve({ error: null });
    },
  }));
  return { inserted, supabaseService: vi.fn(() => ({ from: fromMock })) };
});
vi.mock("../../src/api/supabase.js", () => ({
  supabaseService: h.supabaseService,
  supabaseForUser: vi.fn(),
}));

import { registerGardenPrimitives } from "../../src/tools/garden-primitives.js";

type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<{ content: { type: string; text: string }[] }>;

const MD = Object.keys(PASS4B_BACKLINKS_CORPUS).filter((f) =>
  f.endsWith(".md"),
);

// Spy counters so BL6 can assert the read path: listFileOutlinksMeta IS the
// source (column read) and readFile is bounded to the rendered slice, never a
// full-vault scan.
const spies = { readFileCalls: 0, outlinksMetaCalls: 0 };

function corpusBackend(): StorageBackend {
  return {
    readFile: vi.fn(async (p: string) => {
      spies.readFileCalls += 1;
      if (p in PASS4B_BACKLINKS_CORPUS) return PASS4B_BACKLINKS_CORPUS[p];
      throw new Error(`not found: ${p}`);
    }),
    writeFile: vi.fn(async () => undefined),
    listFiles: vi.fn(async (sub?: string) =>
      sub ? MD.filter((f) => f === sub || f.startsWith(sub + "/")) : MD,
    ),
    exists: vi.fn(async (p: string) => p in PASS4B_BACKLINKS_CORPUS),
    mkdir: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: 0, modifiedAt: new Date() })),
    listChanged: vi.fn(async () => ({
      files: [],
      next: null,
      pendingCount: 0,
    })),
    getCursorHead: vi.fn(async () => null),
    getPendingCount: vi.fn(async () => 0),
    recentFiles: vi.fn(async (n: number) => MD.slice(0, n)),
    listFilesMeta: vi.fn(async (sub?: string): Promise<FileMeta[]> => {
      const all = sub
        ? MD.filter((f) => f === sub || f.startsWith(sub + "/"))
        : MD;
      return all.map((p) => ({
        path: p,
        cardinality: extractCardinality(PASS4B_BACKLINKS_CORPUS[p]),
        tokens: extractTokens(PASS4B_BACKLINKS_CORPUS[p]),
      }));
    }),
    // The simulated stored column: outlinks pre-extracted per file, exactly
    // what the write hook persists. No body decrypt at read time.
    listFileOutlinksMeta: vi.fn(async (sub?: string): Promise<FileMeta[]> => {
      spies.outlinksMetaCalls += 1;
      const all = sub
        ? MD.filter((f) => f === sub || f.startsWith(sub + "/"))
        : MD;
      return all.map((p) => ({
        path: p,
        cardinality: null,
        outlinks: extractOutlinks(PASS4B_BACKLINKS_CORPUS[p]),
      }));
    }),
    batchUpdateCardinalities: vi.fn(async () => undefined),
    batchUpdateTokens: vi.fn(async () => undefined),
    batchUpdateOutlinks: vi.fn(async () => undefined),
  } as unknown as StorageBackend;
}

function handlersForBackend(backend: StorageBackend): Map<string, ToolHandler> {
  const reg = new Map<string, ToolHandler>();
  const server = {
    registerTool: vi.fn((n: string, _c: unknown, fn: ToolHandler) =>
      reg.set(n, fn),
    ),
  } as unknown as McpServer;
  registerGardenPrimitives(server, backend);
  return reg;
}

function handlers(): Map<string, ToolHandler> {
  return handlersForBackend(corpusBackend());
}

// BL-M2 (security-audit) — a cold, all-null extracted_outlinks column. The
// first garden_backlinks call dispatches a fire-and-forget backfill that, on
// b79cdb0, decrypts EVERY file (uncapped). This backend forces that path and
// signals when the backfill flushes (batchUpdateOutlinks) so the test can
// assert the decrypt count is CAPPED, not N.
function nullColumnBackend(onBackfillFlush: () => void): StorageBackend {
  const base = corpusBackend();
  return {
    ...(base as object),
    listFileOutlinksMeta: vi.fn(async (sub?: string): Promise<FileMeta[]> => {
      spies.outlinksMetaCalls += 1;
      const all = sub
        ? MD.filter((f) => f === sub || f.startsWith(sub + "/"))
        : MD;
      return all.map((p) => ({ path: p, cardinality: null, outlinks: null }));
    }),
    batchUpdateOutlinks: vi.fn(async () => {
      onBackfillFlush();
    }),
  } as unknown as StorageBackend;
}

// NIT (build-audit) — a hub with MORE than RESULT_LIMIT inbound links, so the
// "Showing the first N of M" truncation branch (matched.length > shown.length)
// is covered. Synthetic: the frozen corpus can't reach 21 distinct sources.
function hubBackend(n: number, targetKey: string): StorageBackend {
  const srcPaths = Array.from({ length: n }, (_, i) => `notes/hub-src-${i}.md`);
  const base = corpusBackend();
  return {
    ...(base as object),
    readFile: vi.fn(
      async (p: string) => `---\ntitle: ${p}\n---\n[[${targetKey}]]`,
    ),
    listFileOutlinksMeta: vi.fn(
      async (): Promise<FileMeta[]> =>
        srcPaths.map((p) => ({
          path: p,
          cardinality: null,
          outlinks: [targetKey],
        })),
    ),
  } as unknown as StorageBackend;
}

// BL-M2-DRAIN (build-audit follow-up) — BL-M2 proves ONE cold call is capped;
// it does NOT prove repeated calls DRAIN the column to empty. The drain relies
// on three things working together: listFileOutlinksMeta re-queries on a stable
// path order, batchUpdateOutlinks only fills still-null rows (.is(null) guard),
// and the per-backend in-flight guard releases between calls. This stateful
// backend models the real column over a CONTROLLED set of source files (a fresh
// path set — NOT the big shared corpus, whose managed-index row is excluded from
// the scan and so would never drain): listFileOutlinksMeta reflects current
// state (sorted, mirroring .order("path")), each source links to one target, and
// batchUpdateOutlinks persists writes to null rows only. Calling backlinks
// ceil(N/cap) times must reach zero nulls, each step advancing by at most `cap`.
// A regression that re-reads the same head chunk (unstable order) or clobbers a
// populated row would stall or loop here.
function drainingBackend(
  state: Map<string, string[] | null>,
  contentFor: (p: string) => string,
  onFlush: () => void,
): StorageBackend {
  const base = corpusBackend();
  const sortedPaths = () => [...state.keys()].sort();
  return {
    ...(base as object),
    readFile: vi.fn(async (p: string) => {
      spies.readFileCalls += 1;
      if (state.has(p)) return contentFor(p);
      throw new Error(`not found: ${p}`);
    }),
    listFileOutlinksMeta: vi.fn(async (): Promise<FileMeta[]> => {
      spies.outlinksMetaCalls += 1;
      return sortedPaths().map((p) => ({
        path: p,
        cardinality: null,
        outlinks: state.get(p) ?? null,
      }));
    }),
    batchUpdateOutlinks: vi.fn(async (updates: Map<string, string[]>) => {
      for (const [p, ol] of updates) {
        if (state.get(p) == null) state.set(p, ol); // .is(null) write-guard
      }
      onFlush();
    }),
  } as unknown as StorageBackend;
}

const nullCount = (state: Map<string, string[] | null>) =>
  [...state.values()].filter((v) => v == null).length;

const parseRows = (text: string): string[] =>
  [...text.matchAll(/^- \*\*.+?\*\* — (\S+\.md)/gm)].map((m) => m[1]);

async function callBacklinks(
  target: string,
): Promise<{ paths: string[]; text: string }> {
  const handler = handlers().get("garden_backlinks");
  if (!handler) throw new Error("tool not registered: garden_backlinks");
  const res = await handler({ target });
  const text = res.content.map((c) => c.text).join("\n");
  return { paths: parseRows(text), text };
}

const sameSet = (got: string[], want: string[]) =>
  expect(new Set(got)).toEqual(new Set(want));

describe("Pass 4b — garden_backlinks v2 (§1)", () => {
  describe("G-KILL — flag OFF is inert", () => {
    it("flag OFF returns disabled, no rows", async () => {
      const { paths, text } = await callBacklinks(TARGET_M1_BASENAME);
      expect(text).toMatch(/not enabled/i);
      expect(paths).toEqual([]);
    });
  });

  describe("behavior (flag ON)", () => {
    beforeEach(() => {
      process.env.TAPROOT_GARDEN_BACKLINKS = "1";
      spies.readFileCalls = 0;
      spies.outlinksMetaCalls = 0;
    });
    afterEach(() => {
      delete process.env.TAPROOT_GARDEN_BACKLINKS;
    });

    it("BL1 — basic backlinks + false-edge rejection (precision=1.0)", async () => {
      const { paths } = await callBacklinks(TARGET_M1_BASENAME);
      sameSet(paths, [COURSE_INDEX, MODULE3]);
      expect(paths).not.toContain(RECAP); // prose mention is NOT an edge
      expect(paths).not.toContain("index.md");
    });

    it("BL2 — alias display-text stripped before resolve ([[…|Module 1]])", async () => {
      const { paths } = await callBacklinks(TARGET_M1_BASENAME);
      expect(paths).toContain(MODULE3); // module-3 links ONLY via alias + heading
    });

    it("BL3 — heading anchor stripped before resolve ([[…#Frameworks]])", async () => {
      const { paths } = await callBacklinks(TARGET_M1_BASENAME);
      expect(paths).toContain(MODULE3);
    });

    it("BL4 — basename and full-path target resolve identically", async () => {
      const byBasename = (await callBacklinks(TARGET_M1_BASENAME)).paths;
      const byPath = (await callBacklinks(TARGET_M1)).paths;
      sameSet(byBasename, byPath);
      sameSet(byPath, [COURSE_INDEX, MODULE3]);
    });

    it("BL5 — orphan target → honest empty, never confabulated", async () => {
      const { paths, text } = await callBacklinks("orphan-note");
      expect(paths).toEqual([]);
      expect(text).toMatch(/no .*backlink|nothing links|no notes link/i);
      expect(ORPHAN).toBe("notes/orphan-note.md");
    });

    it("BL6 — reads the stored column, never a full-vault body scan (anti-hang)", async () => {
      await callBacklinks(TARGET_M1_BASENAME);
      // The column read is the source of truth.
      expect(spies.outlinksMetaCalls).toBeGreaterThan(0);
      // renderHits reads only the matched slice (2 notes) for titles — NOT the
      // whole corpus. A regression to derive-on-read would readFile every note.
      expect(spies.readFileCalls).toBeLessThanOrEqual(2);
      expect(spies.readFileCalls).toBeLessThan(MD.length);
    });

    it("BL7 — a wikilink only inside a code fence / inline span is NOT a backlink edge (C1)", async () => {
      const { paths } = await callBacklinks(BL7_TARGET);
      expect(paths).not.toContain(BL7_FENCED_SOURCE);
      expect(paths).toEqual([]); // the only occurrence is code-fenced → honest empty
    });

    it("BL-M2 — cold all-null column: backfill decrypts are CAPPED, not N (DoS bound)", async () => {
      process.env.OUTLINK_BACKFILL_CAP = "2";
      spies.readFileCalls = 0;
      let flush!: () => void;
      const flushed = new Promise<void>((r) => (flush = r));
      try {
        const reg = handlersForBackend(nullColumnBackend(flush));
        const handler = reg.get("garden_backlinks");
        if (!handler) throw new Error("tool not registered: garden_backlinks");
        await handler({ target: TARGET_M1_BASENAME });
        await flushed; // wait for the fire-and-forget backfill to flush
        // On b79cdb0 the backfill decrypts every (non-excluded) file (~N);
        // after the cap it reads at most OUTLINK_BACKFILL_CAP.
        expect(spies.readFileCalls).toBeLessThanOrEqual(2);
        expect(spies.readFileCalls).toBeLessThan(MD.length);
      } finally {
        delete process.env.OUTLINK_BACKFILL_CAP;
      }
    });

    it("BL-M2-DRAIN — repeated cold calls drain the column to zero, ≤cap per call", async () => {
      const CAP = 2;
      const TARGET = "drain-target-note";
      const N = 7; // odd + > a couple caps, so the tail (1 file) must drain too
      const srcPaths = Array.from(
        { length: N },
        (_, i) => `notes/drain-src-${i}.md`,
      );
      process.env.OUTLINK_BACKFILL_CAP = String(CAP);
      try {
        // Controlled cold column: N source files, every one links to TARGET.
        const state = new Map<string, string[] | null>(
          srcPaths.map((p) => [p, null]),
        );
        const contentFor = (p: string) =>
          `---\ntitle: ${p}\n---\n[[${TARGET}]]`;
        let flushResolve: (() => void) | null = null;
        const backend = drainingBackend(state, contentFor, () =>
          flushResolve?.(),
        );
        const handler = handlersForBackend(backend).get("garden_backlinks");
        if (!handler) throw new Error("tool not registered: garden_backlinks");

        const expectedSteps = Math.ceil(N / CAP); // 4
        let calls = 0;
        while (nullCount(state) > 0 && calls < expectedSteps + 2) {
          const before = nullCount(state);
          const flushed = new Promise<void>((r) => (flushResolve = r));
          await handler({ target: TARGET });
          // wait for the fire-and-forget backfill flush, then a macrotask so the
          // per-backend in-flight `finally` releases before the next call.
          await Promise.race([flushed, new Promise((r) => setTimeout(r, 50))]);
          await new Promise((r) => setTimeout(r, 5));
          // Per-call advance is bounded by `cap` (the M2 bound holds every call).
          expect(before - nullCount(state)).toBeLessThanOrEqual(CAP);
          calls += 1;
        }
        // Converges to zero (no stalled tail) in ~ceil(N/cap) calls — i.e. it
        // really IS capped-but-progressing, not draining-all-at-once nor looping.
        expect(nullCount(state)).toBe(0);
        expect(calls).toBeLessThanOrEqual(expectedSteps + 1);

        // Now-warm column returns the COMPLETE inbound set (precision + no missed tail).
        const res = await handler({ target: TARGET });
        sameSet(parseRows(res.content.map((c) => c.text).join("\n")), srcPaths);
      } finally {
        delete process.env.OUTLINK_BACKFILL_CAP;
      }
    });

    it("NIT — >RESULT_LIMIT inbound links render the honest truncation message", async () => {
      const reg = handlersForBackend(hubBackend(25, "nit-hub-target"));
      const handler = reg.get("garden_backlinks");
      if (!handler) throw new Error("tool not registered: garden_backlinks");
      const res = await handler({ target: "nit-hub-target" });
      const text = res.content.map((c) => c.text).join("\n");
      expect(text).toMatch(/Showing the first 20 of 25/);
      expect(parseRows(text)).toHaveLength(20);
    });
  });
});
