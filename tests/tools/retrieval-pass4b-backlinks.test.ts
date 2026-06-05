import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../../src/utils/storage.js";
import {
  extractCardinality,
  extractTokens,
} from "../../src/utils/frontmatter.js";
import {
  PASS4B_BACKLINKS_CORPUS,
  TARGET_M1,
  TARGET_M1_BASENAME,
  COURSE_INDEX,
  MODULE3,
  RECAP,
  ORPHAN,
} from "../fixtures/retrieval-pass4b-backlinks/corpus.js";

// ─────────────────────────────────────────────────────────────────────────
// Pass 4b — garden_backlinks (spec §1). Precision = 1.000 is the hard,
// non-negotiable gate: a backlinks tool that invents edges is worse than none.
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

function corpusBackend(): StorageBackend {
  return {
    readFile: vi.fn(async (p: string) => {
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
    recentFiles: vi.fn(async (n: number) => MD.slice(0, n)),
    listChanged: vi.fn(async () => ({
      files: [],
      next: null,
      pendingCount: 0,
    })),
    getCursorHead: vi.fn(async () => null),
    getPendingCount: vi.fn(async () => 0),
    listFilesMeta: vi.fn(async (sub?: string) => {
      const all = sub
        ? MD.filter((f) => f === sub || f.startsWith(sub + "/"))
        : MD;
      return all.map((p) => ({
        path: p,
        cardinality: extractCardinality(PASS4B_BACKLINKS_CORPUS[p]),
        tokens: extractTokens(PASS4B_BACKLINKS_CORPUS[p]),
      }));
    }),
    batchUpdateCardinalities: vi.fn(async () => undefined),
    batchUpdateTokens: vi.fn(async () => undefined),
  } as unknown as StorageBackend;
}

function handlers(): Map<string, ToolHandler> {
  const reg = new Map<string, ToolHandler>();
  const server = {
    registerTool: vi.fn((n: string, _c: unknown, fn: ToolHandler) =>
      reg.set(n, fn),
    ),
  } as unknown as McpServer;
  registerGardenPrimitives(server, corpusBackend());
  return reg;
}

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

describe("Pass 4b — garden_backlinks (§1)", () => {
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
      // module-3's heading link must resolve to the target, not target#frameworks.
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
      // sanity: the orphan note exists, it simply has no inbound links.
      expect(ORPHAN).toBe("notes/orphan-note.md");
    });
  });
});
