import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../../src/utils/storage.js";
import {
  extractCardinality,
  extractTokens,
} from "../../src/utils/frontmatter.js";
import { CORPUS } from "../fixtures/retrieval-pass3/corpus.js";

// ─────────────────────────────────────────────────────────────────────────
// Pass 2 honesty-contract evals (EVALS HC1–HC9 / NR1–NR4). Drives the REAL
// garden_find / garden_forage / taproot_harvest handlers against the frozen
// retrieval-pass3 corpus and asserts the honesty block is PRESENT on thin/miss
// queries when TAPROOT_HONESTY_CONTRACT=1, and ABSENT on strong queries / when
// the flag is off (kill switch). Failing-eval-first: the HC cases are RED on
// pre-Pass-2 code (no honesty module) and GREEN after C1–C4.
//
// The contract is DECOUPLED from the ranking flag (SPEC §5-RESOLVED) — the
// honesty index builds from getRetrievalIndex regardless of V1/V2. These evals
// run under V2 (the forward path) but the section builder is V1-safe by design.
// ─────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => {
  const inserted: any[] = [];
  const fromMock = vi.fn((_t: string) => ({
    insert: (row: unknown) => {
      inserted.push(row);
      return Promise.resolve({ error: null });
    },
  }));
  const supabaseService = vi.fn(() => ({ from: fromMock }));
  return { inserted, supabaseService };
});

vi.mock("../../src/api/supabase.js", () => ({
  supabaseService: h.supabaseService,
  supabaseForUser: vi.fn(),
}));

import { registerVaultTools } from "../../src/tools/vault.js";
import { registerKnowledgeTools } from "../../src/tools/knowledge.js";

type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

function makeServerCapture() {
  const registered = new Map<string, ToolHandler>();
  const server = {
    registerTool: vi.fn(
      (name: string, _config: unknown, handler: ToolHandler) => {
        registered.set(name, handler);
      },
    ),
  } as unknown as McpServer;
  return { server, registered };
}

const MD = Object.keys(CORPUS).filter((f) => f.endsWith(".md"));

function corpusBackend(): StorageBackend {
  return {
    readFile: vi.fn(async (p: string) => {
      if (p in CORPUS) return CORPUS[p];
      throw new Error(`not found: ${p}`);
    }),
    writeFile: vi.fn(async () => undefined),
    listFiles: vi.fn(async (sub?: string) => {
      if (!sub) return MD;
      return MD.filter((f) => f === sub || f.startsWith(sub + "/"));
    }),
    exists: vi.fn(
      async (p: string) => p in CORPUS || MD.some((f) => f.startsWith(p + "/")),
    ),
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
        cardinality: extractCardinality(CORPUS[p]),
        tokens: extractTokens(CORPUS[p]),
      }));
    }),
    batchUpdateCardinalities: vi.fn(async () => undefined),
    batchUpdateTokens: vi.fn(async () => undefined),
  } as unknown as StorageBackend;
}

type Tool = "find" | "forage" | "harvest";
const TOOL_NAME: Record<Tool, string> = {
  find: "garden_find",
  forage: "garden_forage",
  harvest: "taproot_harvest",
};

// Honesty-block detection: the rendered block always carries this header.
const HONESTY_HEADER = "Closest context in your vault";
const hasHonestyBlock = (text: string) => text.includes(HONESTY_HEADER);

async function run(
  handlers: Map<string, ToolHandler>,
  tool: Tool,
  query: string,
): Promise<{
  text: string;
  flags: Record<string, unknown>;
  noResults: boolean;
}> {
  h.inserted.length = 0;
  const handler = handlers.get(TOOL_NAME[tool])!;
  const args =
    tool === "find"
      ? { query, limit: 10 }
      : tool === "forage"
        ? { query, maxResults: 20 }
        : { question: query, save: false };
  const res = await handler(args);
  const text = res.content.map((c) => c.text).join("\n");
  const row = h.inserted[h.inserted.length - 1];
  return {
    text,
    flags: (row?.branch_flags as Record<string, unknown>) ?? {},
    noResults: Boolean(row?.outcome?.no_results),
  };
}

function freshHandlers(): Map<string, ToolHandler> {
  const { server, registered } = makeServerCapture();
  registerVaultTools(server, corpusBackend());
  registerKnowledgeTools(server, corpusBackend());
  return registered;
}

// ── HC: contract PRESENT on thin/miss under the flag ──
describe("Pass 2 honesty contract — present on thin/miss (flag ON, V2)", () => {
  let handlers: Map<string, ToolHandler>;
  beforeEach(() => {
    process.env.TAPROOT_RETRIEVAL_V2 = "1";
    process.env.TAPROOT_HONESTY_CONTRACT = "1";
    delete process.env.SCAN_FILE_CAP;
    handlers = freshHandlers();
  });
  afterEach(() => {
    delete process.env.TAPROOT_RETRIEVAL_V2;
    delete process.env.TAPROOT_HONESTY_CONTRACT;
  });

  it("HC1 — genuine miss 'quantum computing notes' stays no_results AND gains a honesty block", async () => {
    const { text, noResults } = await run(
      handlers,
      "find",
      "quantum computing notes",
    );
    expect(noResults).toBe(true); // no confabulation — gold stays empty
    expect(hasHonestyBlock(text)).toBe(true);
  });

  it("HC2 — partial coverage 'stripe quantum webhook' surfaces the unmatched 'quantum'", async () => {
    const { text } = await run(handlers, "find", "stripe quantum webhook");
    expect(hasHonestyBlock(text)).toBe(true);
  });

  it("HC3 — typo 'Taprot pricing' yields a Did you mean: taproot", async () => {
    const { text } = await run(handlers, "find", "Taprot pricing");
    expect(text).toContain("Did you mean");
    expect(text.toLowerCase()).toContain("taproot");
  });

  it("HC4 — identifier near-miss 'is7012' surfaces related identifier is7011", async () => {
    const { text } = await run(handlers, "find", "is7012");
    expect(hasHonestyBlock(text)).toBe(true);
    expect(text.toLowerCase()).toContain("is7011");
  });

  it("HC5 — forage miss gains a honesty block", async () => {
    const { text, noResults } = await run(
      handlers,
      "forage",
      "quantum computing",
    );
    expect(noResults).toBe(true);
    expect(hasHonestyBlock(text)).toBe(true);
  });

  it("HC6 — all-stopwords query emits no did-you-mean noise", async () => {
    const { text } = await run(handlers, "find", "what when");
    expect(text).not.toContain("Did you mean");
  });

  it("HC7 — empty/whitespace query does not crash and emits no block", async () => {
    const { text } = await run(handlers, "find", "   ");
    expect(hasHonestyBlock(text)).toBe(false);
  });
});

// ── NR: contract SILENT on strong results ──
describe("Pass 2 honesty contract — silent on strong results (flag ON, V2)", () => {
  let handlers: Map<string, ToolHandler>;
  beforeEach(() => {
    process.env.TAPROOT_RETRIEVAL_V2 = "1";
    process.env.TAPROOT_HONESTY_CONTRACT = "1";
    delete process.env.SCAN_FILE_CAP;
    handlers = freshHandlers();
  });
  afterEach(() => {
    delete process.env.TAPROOT_RETRIEVAL_V2;
    delete process.env.TAPROOT_HONESTY_CONTRACT;
  });

  it("NR1 — 'mcp 7-pass roadmap' is strong → no honesty block", async () => {
    const { text } = await run(handlers, "find", "mcp 7-pass roadmap");
    expect(text).toContain(
      "decisions/taproot/2026-05-28-mcp-7-pass-roadmap.md",
    );
    expect(hasHonestyBlock(text)).toBe(false);
  });

  it("NR3 — 'IS 7011' is strong under V2 → no honesty block", async () => {
    const { text } = await run(handlers, "find", "IS 7011");
    expect(hasHonestyBlock(text)).toBe(false);
  });
});

// ── NR4: kill switch — flag OFF ⇒ byte-for-byte current output ──
describe("Pass 2 honesty contract — kill switch (flag OFF)", () => {
  beforeEach(() => {
    process.env.TAPROOT_RETRIEVAL_V2 = "1";
    delete process.env.TAPROOT_HONESTY_CONTRACT;
    delete process.env.SCAN_FILE_CAP;
  });
  afterEach(() => {
    delete process.env.TAPROOT_RETRIEVAL_V2;
  });

  it("NR4 — miss query has NO honesty block when the flag is unset", async () => {
    const handlers = freshHandlers();
    const { text } = await run(handlers, "find", "quantum computing notes");
    expect(hasHonestyBlock(text)).toBe(false);
  });
});
