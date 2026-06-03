import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../../src/utils/storage.js";
import {
  extractCardinality,
  extractTokens,
} from "../../src/utils/frontmatter.js";
import { CORPUS } from "../fixtures/retrieval-pass3/corpus.js";

// ─────────────────────────────────────────────────────────────────────────
// Pass 3 retrieval A/B harness (EVALS Part 3 / SPEC Part 3). Drives the REAL
// garden_find / garden_forage / taproot_harvest handlers against the frozen
// fixture, parses ordered result paths from tool output + branch_flags from the
// telemetry sink, and auto-scores Gold@3 / Anti-gold@3 / Recall@10 / MRR.
//
// C4 scope: capture the V1 FLOOR (= current code failing the gold set — the
// failing-eval-first evidence) and assert Control (G1/G2/G3) non-regression
// under V1. The A2 hard gate + V2 ship-bar assertions are written but skipped
// until garden_find V2 is wired (C5) and all tools are V2 (C8).
//
// The B1 production backfill predicate is tested separately in
// tests/tools/index-tool.token-backfill.test.ts — this in-memory harness
// bypasses loadIndexData's predicate by construction (PLAN C4 / AUDIT B1).
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
    // Recency proxy: date-stamped files newest-first, then undated.
    recentFiles: vi.fn(async (n: number) => {
      const dated = MD.filter((f) => /\d{4}-\d{2}-\d{2}/.test(f)).sort((a, b) =>
        b.localeCompare(a),
      );
      const undated = MD.filter((f) => !/\d{4}-\d{2}-\d{2}/.test(f));
      return [...dated, ...undated].slice(0, n);
    }),
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

// Parse ordered result paths from each tool's text output.
function parsePaths(tool: Tool, text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p?: string) => {
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  const re =
    tool === "find"
      ? /^- \*\*.+?\*\* — (\S+\.md)/gm
      : tool === "forage"
        ? /(\S+\.md) \(\d+ match/g
        : /^### (\S+\.md)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) push(m[1]);
  return out;
}

async function runQuery(
  handlers: Map<string, ToolHandler>,
  tool: Tool,
  query: string,
): Promise<{
  paths: string[];
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
    paths: parsePaths(tool, text),
    flags: (row?.branch_flags as Record<string, unknown>) ?? {},
    noResults: Boolean(row?.outcome?.no_results),
  };
}

// ── The 18-query gold set (EVALS Part 1), pinned to the frozen fixture ──
const COURSE = [
  "school/is-7011-it-management/module-1-it-competitive-advantage.md",
  "school/is-7011-it-management/module-2-data-governance.md",
];
interface GoldQuery {
  id: string;
  cat: string;
  query: string;
  tool: Tool;
  gold: string[];
  antiGold?: string[];
}
const GOLD: GoldQuery[] = [
  {
    id: "A1",
    cat: "A",
    query: "is-7011-it-management",
    tool: "harvest",
    gold: COURSE,
  },
  {
    id: "A2",
    cat: "A",
    query: "IS 7011",
    tool: "find",
    gold: COURSE,
    antiGold: [
      "daily/2026-05/2026-05-10-pricing-decisions.md",
      "daily/2026-05/2026-05-11-competitor-analysis.md",
      "daily/2026-05/2026-05-12-revised-roadmap.md",
      "daily/2026-05/2026-05-14-advisory-notes.md",
    ],
  },
  { id: "A3", cat: "A", query: "7011", tool: "find", gold: COURSE },
  { id: "A4", cat: "A", query: "IS7011", tool: "find", gold: COURSE },
  {
    id: "A5",
    cat: "A",
    query: "what is IS-7011 about",
    tool: "harvest",
    gold: COURSE,
  },
  {
    id: "B1",
    cat: "B",
    query: "AI",
    tool: "find",
    gold: [
      "school/ai-governance/ai-risk-frameworks.md",
      "school/ai-powered-bots/building-ai-agents.md",
    ],
    antiGold: [
      "daily/2026-05/2026-05-15-main-loop-refactor.md",
      "daily/2026-05/2026-05-16-await-queue-fix.md",
      "daily/2026-05/2026-05-18-again-retrospective.md",
    ],
  },
  {
    id: "B2",
    cat: "B",
    query: "PR",
    tool: "find",
    gold: [
      "daily/2026-05/2026-05-21-pr7-stripe-webhook-shipped.md",
      "daily/2026-05/2026-05-22-pr8-oauth-fix.md",
      "daily/2026-05/2026-05-23-pr9-telemetry-wrapper.md",
    ],
    antiGold: ["notes/prune-old-notes.md"],
  },
  {
    id: "B3",
    cat: "B",
    query: "MCP",
    tool: "find",
    gold: [
      "decisions/taproot/2026-05-28-mcp-7-pass-roadmap.md",
      "decisions/taproot/2026-05-28-mcp-tooling-audit-handoff.md",
    ],
  },
  {
    id: "C1",
    cat: "C",
    query: "Taproot pricing",
    tool: "find",
    gold: ["decisions/2026-05-12-taproot-pricing-model.md"],
  },
  {
    id: "C2",
    cat: "C",
    query: "stripe webhook errors",
    tool: "forage",
    gold: ["daily/2026-05/2026-05-21-pr7-stripe-webhook-shipped.md"],
  },
  {
    id: "C3",
    cat: "C",
    query: "why did we kill freemium",
    tool: "harvest",
    gold: ["decisions/2026-05-12-taproot-pricing-model.md"],
  },
  {
    id: "E1",
    cat: "E",
    query: "cold DM script for Taproot",
    tool: "find",
    gold: [
      "projects/taproot/gtm/outbound-dm-copy.md",
      "projects/taproot/gtm/dm-framework-pain-to-pitch.md",
      "projects/taproot/gtm/2026-05-13-dm-loom-script.md",
    ],
  },
  {
    id: "F1",
    cat: "F",
    query: "quantum computing notes",
    tool: "find",
    gold: [],
  },
  {
    id: "G1",
    cat: "G",
    query: "garden find hang fix",
    tool: "find",
    gold: ["daily/2026-06/2026-06-01-garden-find-hang-fix-session-a.md"],
  },
  {
    id: "G2",
    cat: "G",
    query: "mcp 7-pass roadmap",
    tool: "find",
    gold: ["decisions/taproot/2026-05-28-mcp-7-pass-roadmap.md"],
  },
  {
    id: "G3",
    cat: "G",
    query: "taproot pricing model",
    tool: "find",
    gold: ["decisions/2026-05-12-taproot-pricing-model.md"],
  },
];

// ── Scoring ──
const inTopK = (paths: string[], set: string[], k: number) =>
  set.some((g) => paths.slice(0, k).includes(g));
const recallAt = (paths: string[], gold: string[], k: number) =>
  gold.length === 0
    ? 1
    : gold.filter((g) => paths.slice(0, k).includes(g)).length / gold.length;
const mrr = (paths: string[], gold: string[]) => {
  const i = paths.slice(0, 10).findIndex((p) => gold.includes(p));
  return i === -1 ? 0 : 1 / (i + 1);
};

describe("Pass 3 retrieval — V1 floor (failing-eval-first evidence)", () => {
  let handlers: Map<string, ToolHandler>;
  beforeEach(() => {
    delete process.env.TAPROOT_RETRIEVAL_V2;
    delete process.env.SCAN_FILE_CAP;
    const { server, registered } = makeServerCapture();
    const backend = corpusBackend();
    registerVaultTools(server, backend);
    registerKnowledgeTools(server, backend);
    handlers = registered;
  });
  afterEach(() => {
    delete process.env.TAPROOT_RETRIEVAL_V2;
  });

  it("captures + dumps the V1 baseline across all 18 queries", async () => {
    const rows: Record<string, unknown>[] = [];
    const byCat: Record<
      string,
      { g3: number[]; ag3: number[]; r10: number[]; mrr: number[] }
    > = {};
    for (const q of GOLD) {
      const { paths, flags, noResults } = await runQuery(
        handlers,
        q.tool,
        q.query,
      );
      const g3 =
        q.gold.length === 0
          ? noResults
            ? 1
            : 0
          : inTopK(paths, q.gold, 3)
            ? 1
            : 0;
      const ag3 = q.antiGold && inTopK(paths, q.antiGold, 3) ? 1 : 0;
      const r10 = recallAt(paths, q.gold, 10);
      const mrrV =
        q.gold.length === 0 ? (noResults ? 1 : 0) : mrr(paths, q.gold);
      byCat[q.cat] ??= { g3: [], ag3: [], r10: [], mrr: [] };
      byCat[q.cat].g3.push(g3);
      byCat[q.cat].ag3.push(ag3);
      byCat[q.cat].r10.push(r10);
      byCat[q.cat].mrr.push(mrrV);
      rows.push({
        id: q.id,
        tool: q.tool,
        gold3: g3,
        antiGold3: ag3,
        recall10: Number(r10.toFixed(2)),
        mrr: Number(mrrV.toFixed(2)),
        noResults,
        top3: paths.slice(0, 3).join(" | ") || "(none)",
        body_fb: flags.body_fallback_fired,
        scoring_path: flags.scoring_path,
      });
    }
    const avg = (xs: number[]) =>
      xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    const catSummary = Object.fromEntries(
      Object.entries(byCat).map(([c, m]) => [
        c,
        {
          gold3: Number(avg(m.g3).toFixed(2)),
          antiGold3: Number(avg(m.ag3).toFixed(2)),
          recall10: Number(avg(m.r10).toFixed(2)),
          mrr: Number(avg(m.mrr).toFixed(2)),
        },
      ]),
    );
    // V1 FLOOR — record into the PLAN VERIFY section.
    // eslint-disable-next-line no-console
    console.log("\n=== Pass 3 V1 FLOOR (per query) ===");
    // eslint-disable-next-line no-console
    console.table(rows);
    // eslint-disable-next-line no-console
    console.log("=== Pass 3 V1 FLOOR (per category) ===");
    // eslint-disable-next-line no-console
    console.table(catSummary);
    const trap = ["A", "B", "C", "E"].flatMap((c) => byCat[c]?.g3 ?? []);
    // eslint-disable-next-line no-console
    console.log(`V1 trap Gold@3 (A+B+C+E) = ${avg(trap).toFixed(3)}`);
    expect(rows.length).toBe(GOLD.length);
  });
});

describe("Pass 3 retrieval — Control non-regression under V1 (hard gate)", () => {
  let handlers: Map<string, ToolHandler>;
  beforeEach(() => {
    delete process.env.TAPROOT_RETRIEVAL_V2;
    delete process.env.SCAN_FILE_CAP;
    const { server, registered } = makeServerCapture();
    registerVaultTools(server, corpusBackend());
    registerKnowledgeTools(server, corpusBackend());
    handlers = registered;
  });

  it("G1 — `garden find hang fix` is top-1 under V1", async () => {
    const { paths } = await runQuery(handlers, "find", "garden find hang fix");
    expect(paths[0]).toBe(
      "daily/2026-06/2026-06-01-garden-find-hang-fix-session-a.md",
    );
  });

  it("G2 — `mcp 7-pass roadmap` is top-1 under V1", async () => {
    const { paths } = await runQuery(handlers, "find", "mcp 7-pass roadmap");
    expect(paths[0]).toBe("decisions/taproot/2026-05-28-mcp-7-pass-roadmap.md");
  });

  it("G3 — `taproot pricing model` is top-3 under V1", async () => {
    const { paths } = await runQuery(handlers, "find", "taproot pricing model");
    expect(paths.slice(0, 3)).toContain(
      "decisions/2026-05-12-taproot-pricing-model.md",
    );
  });
});

const A2_ANTI_GOLD = [
  "daily/2026-05/2026-05-10-pricing-decisions.md",
  "daily/2026-05/2026-05-11-competitor-analysis.md",
  "daily/2026-05/2026-05-12-revised-roadmap.md",
  "daily/2026-05/2026-05-14-advisory-notes.md",
];

describe("Pass 3 retrieval — Control non-regression under V2 (hard gate)", () => {
  let handlers: Map<string, ToolHandler>;
  beforeEach(() => {
    process.env.TAPROOT_RETRIEVAL_V2 = "1";
    delete process.env.SCAN_FILE_CAP;
    const { server, registered } = makeServerCapture();
    registerVaultTools(server, corpusBackend());
    registerKnowledgeTools(server, corpusBackend());
    handlers = registered;
  });
  afterEach(() => {
    delete process.env.TAPROOT_RETRIEVAL_V2;
  });

  it("G1 — `garden find hang fix` is top-1 under V2", async () => {
    const { paths } = await runQuery(handlers, "find", "garden find hang fix");
    expect(paths[0]).toBe(
      "daily/2026-06/2026-06-01-garden-find-hang-fix-session-a.md",
    );
  });

  it("G2 — `mcp 7-pass roadmap` is top-1 under V2", async () => {
    const { paths } = await runQuery(handlers, "find", "mcp 7-pass roadmap");
    expect(paths[0]).toBe("decisions/taproot/2026-05-28-mcp-7-pass-roadmap.md");
  });

  it("G3 — `taproot pricing model` is top-3 under V2", async () => {
    const { paths } = await runQuery(handlers, "find", "taproot pricing model");
    expect(paths.slice(0, 3)).toContain(
      "decisions/2026-05-12-taproot-pricing-model.md",
    );
  });
});

describe("Pass 3 retrieval — A2 hard gate (V2)", () => {
  let handlers: Map<string, ToolHandler>;
  beforeEach(() => {
    process.env.TAPROOT_RETRIEVAL_V2 = "1";
    delete process.env.SCAN_FILE_CAP;
    const { server, registered } = makeServerCapture();
    registerVaultTools(server, corpusBackend());
    registerKnowledgeTools(server, corpusBackend());
    handlers = registered;
  });
  afterEach(() => {
    delete process.env.TAPROOT_RETRIEVAL_V2;
  });

  it("A2 — `IS 7011` returns a school/is-7011-it-management/** course note in top-3", async () => {
    const { paths } = await runQuery(handlers, "find", "IS 7011");
    const top3 = paths.slice(0, 3);
    expect(
      top3.some((p) => p.startsWith("school/is-7011-it-management/")),
    ).toBe(true);
  });

  it("A2 — zero short-substring-only anti-gold in top-3", async () => {
    const { paths } = await runQuery(handlers, "find", "IS 7011");
    const top3 = paths.slice(0, 3);
    expect(A2_ANTI_GOLD.some((a) => top3.includes(a))).toBe(false);
  });
});

describe("Pass 3 retrieval — garden_forage V2 (RC #5)", () => {
  it("C2 — `stripe webhook errors` finds the body-resident pr7 note under V2", async () => {
    process.env.TAPROOT_RETRIEVAL_V2 = "1";
    delete process.env.SCAN_FILE_CAP;
    const { server, registered } = makeServerCapture();
    registerVaultTools(server, corpusBackend());
    registerKnowledgeTools(server, corpusBackend());
    try {
      const { paths } = await runQuery(
        registered,
        "forage",
        "stripe webhook errors",
      );
      expect(paths).toContain(
        "daily/2026-05/2026-05-21-pr7-stripe-webhook-shipped.md",
      );
    } finally {
      delete process.env.TAPROOT_RETRIEVAL_V2;
    }
  });
});

describe("Pass 3 retrieval — taproot_harvest V2 (RC #3/#4)", () => {
  let handlers: Map<string, ToolHandler>;
  beforeEach(() => {
    process.env.TAPROOT_RETRIEVAL_V2 = "1";
    delete process.env.SCAN_FILE_CAP;
    const { server, registered } = makeServerCapture();
    registerVaultTools(server, corpusBackend());
    registerKnowledgeTools(server, corpusBackend());
    handlers = registered;
  });
  afterEach(() => {
    delete process.env.TAPROOT_RETRIEVAL_V2;
  });

  it("A1 — `is-7011-it-management` surfaces a course note with scoring_path=body", async () => {
    const { paths, flags } = await runQuery(
      handlers,
      "harvest",
      "is-7011-it-management",
    );
    expect(
      paths.some((p) => p.startsWith("school/is-7011-it-management/")),
    ).toBe(true);
    // RC #4: body-token relevance entered the score, not a junk index summary.
    expect(flags.scoring_path).toBe("body");
  });

  it("C3 — `why did we kill freemium` finds the pricing-model decision (body synthesis)", async () => {
    const { paths } = await runQuery(
      handlers,
      "harvest",
      "why did we kill freemium",
    );
    expect(paths).toContain("decisions/2026-05-12-taproot-pricing-model.md");
  });
});

describe("Pass 3 retrieval — V2 ship-bar", () => {
  // Un-skipped in C8 once all three tools are on V2.
  it.skip("V2 ship-bar — A2 gate + anti-gold=0 + A4/C2 recovered + F1 clean + Gold@3(A+B+C)>=0.90 (C8)", () => {});
});
