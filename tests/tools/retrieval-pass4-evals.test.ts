import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../../src/utils/storage.js";
import {
  extractCardinality,
  extractTokens,
} from "../../src/utils/frontmatter.js";
import { PASS4_CORPUS } from "../fixtures/retrieval-pass4/corpus.js";

// ─────────────────────────────────────────────────────────────────────────
// Pass 4a primitives eval harness (EVALS 2026-06-04-pass-4-primitives-evals
// §2–4 + cross-cutting; PLAN 2026-06-04-pass-4a-plan §4/§7). Mirrors the Pass 3
// harness (makeServerCapture / corpusBackend / telemetry sink) but drives the
// THREE new read-only primitives — garden_identifier / garden_query /
// garden_cluster — against the Pass 4 corpus (Pass 3 corpus + the is7012 foil).
//
// FAILING-EVAL-FIRST (the PROVE non-negotiable): these tools don't exist as
// behavior yet — the scaffold (e1e6d37) registers them INERT (flag-OFF →
// "disabled", flag-ON → not-implemented stub). So:
//   • Kill-switch (flag-OFF) + G-NONREG + G-READONLY/CL4 are GREEN now (they
//     assert the inert/safety invariants the scaffold already satisfies).
//   • Every BEHAVIOR bar (IDN1–5, GQ1–4 precision, GQ5 top-5, CL1/CL2 purity,
//     CL3 title-overlap) is RED now (the stub returns notImplemented) and turns
//     GREEN as each handler lands (PLAN §7 steps 3–5).
// This file is committed RED as the baseline; do not relax a bar to make it pass.
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

import { registerGardenPrimitives } from "../../src/tools/garden-primitives.js";
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

const MD = Object.keys(PASS4_CORPUS).filter((f) => f.endsWith(".md"));

function corpusBackend(): StorageBackend {
  return {
    readFile: vi.fn(async (p: string) => {
      if (p in PASS4_CORPUS) return PASS4_CORPUS[p];
      throw new Error(`not found: ${p}`);
    }),
    writeFile: vi.fn(async () => undefined),
    listFiles: vi.fn(async (sub?: string) => {
      if (!sub) return MD;
      return MD.filter((f) => f === sub || f.startsWith(sub + "/"));
    }),
    exists: vi.fn(
      async (p: string) =>
        p in PASS4_CORPUS || MD.some((f) => f.startsWith(p + "/")),
    ),
    mkdir: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: 0, modifiedAt: new Date() })),
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
        cardinality: extractCardinality(PASS4_CORPUS[p]),
        tokens: extractTokens(PASS4_CORPUS[p]),
      }));
    }),
    batchUpdateCardinalities: vi.fn(async () => undefined),
    batchUpdateTokens: vi.fn(async () => undefined),
  } as unknown as StorageBackend;
}

// ── Tool drivers ──────────────────────────────────────────────────────────
// Each primitive prints its own format → its own parse branch (PLAN §4):
//   identifier + query: find's row format  `- **<title>** — <path>.md`
//   cluster: per-cluster MEMBER lines       `- <path>.md`  (no bold/em-dash)
const parseRows = (text: string): string[] =>
  [...text.matchAll(/^- \*\*.+?\*\* — (\S+\.md)/gm)].map((m) => m[1]);
const parseMembers = (text: string): string[] =>
  [...text.matchAll(/^- (\S+\.md)\s*$/gm)].map((m) => m[1]);
const parseLandingTitles = (text: string): string[] =>
  [...text.matchAll(/Suggested landing note: `[^`]+` — "([^"]+)"/g)].map(
    (m) => m[1],
  );

interface GardenCall {
  text: string;
  paths: string[];
  members: string[];
  landingTitles: string[];
  flags: Record<string, unknown>;
  noResults: boolean;
}

async function callGarden(
  handlers: Map<string, ToolHandler>,
  name: string,
  args: Record<string, unknown>,
): Promise<GardenCall> {
  h.inserted.length = 0;
  const handler = handlers.get(name);
  if (!handler) throw new Error(`tool not registered: ${name}`);
  const res = await handler(args);
  const text = res.content.map((c) => c.text).join("\n");
  const row = h.inserted[h.inserted.length - 1];
  return {
    text,
    paths: parseRows(text),
    members: parseMembers(text),
    landingTitles: parseLandingTitles(text),
    flags: (row?.branch_flags as Record<string, unknown>) ?? {},
    noResults: Boolean(row?.outcome?.no_results),
  };
}

function gardenHandlers(): {
  handlers: Map<string, ToolHandler>;
  backend: StorageBackend;
} {
  const { server, registered } = makeServerCapture();
  const backend = corpusBackend();
  registerGardenPrimitives(server, backend);
  return { handlers: registered, backend };
}

// ── Corpus paths (pinned to PASS4_CORPUS) ──
const M1 = "school/is-7011-it-management/module-1-it-competitive-advantage.md";
const M2 = "school/is-7011-it-management/module-2-data-governance.md";
const IS7011_DAILY =
  "daily/2026-05/2026-05-17-is7011-case-writeup-1-handoff.md";
const IS7012_NOTE = "daily/2026-05/2026-05-26-is7012-new-course.md";
const INDEX = "index.md";
const PR7 = "daily/2026-05/2026-05-21-pr7-stripe-webhook-shipped.md";
const PR8 = "daily/2026-05/2026-05-22-pr8-oauth-fix.md";
const PR9 = "daily/2026-05/2026-05-23-pr9-telemetry-wrapper.md";
const PRICING = "decisions/2026-05-12-taproot-pricing-model.md";
const PRICING_DAILY = "daily/2026-05/2026-05-10-pricing-decisions.md";
const AI_RISK = "school/ai-governance/ai-risk-frameworks.md";
const AI_AGENTS = "school/ai-powered-bots/building-ai-agents.md";
const ROADMAP = "decisions/taproot/2026-05-28-mcp-7-pass-roadmap.md";
const AUDIT_HANDOFF =
  "decisions/taproot/2026-05-28-mcp-tooling-audit-handoff.md";
const STANDUP = "daily/2026-06/2026-06-02-standup.md";
const GTM = [
  "projects/taproot/gtm/outbound-dm-copy.md",
  "projects/taproot/gtm/dm-framework-pain-to-pitch.md",
  "projects/taproot/gtm/2026-05-13-dm-loom-script.md",
];

const sameSet = (got: string[], want: string[]) =>
  expect(new Set(got)).toEqual(new Set(want));
const purity = (members: string[], gold: string[]) =>
  members.length === 0
    ? 0
    : members.filter((m) => gold.includes(m)).length / members.length;

afterEach(() => {
  delete process.env.TAPROOT_GARDEN_IDENTIFIER;
  delete process.env.TAPROOT_GARDEN_QUERY;
  delete process.env.TAPROOT_GARDEN_CLUSTER;
});

// ═══════════════════════════════════════════════════════════════════════════
// G-KILL — flag-OFF inert (GREEN now: the scaffold already satisfies this)
// ═══════════════════════════════════════════════════════════════════════════
describe("Pass 4a — G-KILL: flag-OFF is inert, no index read", () => {
  for (const [tool, arg] of [
    ["garden_identifier", { identifier: "is7011" }],
    ["garden_query", { query: "tag:ai folder:school" }],
    ["garden_cluster", { seed: M1 }],
  ] as const) {
    it(`${tool} — flag OFF returns disabled, reads no index`, async () => {
      const { handlers, backend } = gardenHandlers();
      const r = await callGarden(handlers, tool, arg);
      expect(r.text).toMatch(/not enabled/i);
      expect(r.paths).toEqual([]);
      expect(r.flags.tool_disabled).toBe(true);
      // NO index read on the disabled path.
      expect(backend.listFilesMeta).not.toHaveBeenCalled();
    });
  }

  it("flags are independent — one ON does not enable the others", async () => {
    process.env.TAPROOT_GARDEN_IDENTIFIER = "1";
    const { handlers } = gardenHandlers();
    const q = await callGarden(handlers, "garden_query", {
      query: "pr7 OR pr8",
    });
    expect(q.text).toMatch(/not enabled/i);
    expect(q.flags.tool_disabled).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// garden_identifier — exact precision + run-collision + related-id + hint
// (BEHAVIOR bars — RED until PLAN §7.3)
// ═══════════════════════════════════════════════════════════════════════════
describe("Pass 4a — garden_identifier (§2)", () => {
  beforeEach(() => {
    process.env.TAPROOT_GARDEN_IDENTIFIER = "1";
  });

  it("IDN1 — `is7011` recalls course notes via the 7011 sub-token, excludes is7012 + managed index (precision=1.0)", async () => {
    const { handlers } = gardenHandlers();
    const r = await callGarden(handlers, "garden_identifier", {
      identifier: "is7011",
    });
    sameSet(r.paths, [M1, M2, IS7011_DAILY]);
    expect(r.paths).not.toContain(IS7012_NOTE);
    expect(r.paths).not.toContain(INDEX);
  });

  it("IDN2 — `pr7` returns pr7 only, never pr8/pr9 (run-collision precision=1.0)", async () => {
    const { handlers } = gardenHandlers();
    const r = await callGarden(handlers, "garden_identifier", {
      identifier: "pr7",
    });
    sameSet(r.paths, [PR7]);
    expect(r.paths).not.toContain(PR8);
    expect(r.paths).not.toContain(PR9);
  });

  it("IDN3 — `IS 7011` / `is-7011` / `IS7011` all normalize to the IDN1 gold", async () => {
    for (const identifier of ["IS 7011", "is-7011", "IS7011"]) {
      const { handlers } = gardenHandlers();
      const r = await callGarden(handlers, "garden_identifier", { identifier });
      sameSet(r.paths, [M1, M2, IS7011_DAILY]);
      expect(r.paths).not.toContain(INDEX);
    }
  });

  it("IDN4 — `is7013` (absent) returns zero exact hits and suggests is7011 + is7012", async () => {
    const { handlers } = gardenHandlers();
    const r = await callGarden(handlers, "garden_identifier", {
      identifier: "is7013",
    });
    expect(r.paths).toEqual([]); // no false-exact hits
    expect(r.noResults).toBe(true);
    expect(r.text).toMatch(/is7011/);
    expect(r.text).toMatch(/is7012/);
  });

  it("IDN5 — `is` (non-identifier) returns empty-with-hint, no content as exact hits", async () => {
    const { handlers } = gardenHandlers();
    const r = await callGarden(handlers, "garden_identifier", {
      identifier: "is",
    });
    expect(r.paths).toEqual([]);
    expect(r.noResults).toBe(true);
    expect(r.text).toMatch(/digit|garden_find/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// garden_query — structured/boolean precision (BEHAVIOR bars — RED until §7.4)
// ═══════════════════════════════════════════════════════════════════════════
describe("Pass 4a — garden_query (§3)", () => {
  beforeEach(() => {
    process.env.TAPROOT_GARDEN_QUERY = "1";
  });

  it("GQ1 — `tag:ai folder:school` → exact scope AND (precision=1.0)", async () => {
    const { handlers } = gardenHandlers();
    const r = await callGarden(handlers, "garden_query", {
      query: "tag:ai folder:school",
    });
    sameSet(r.paths, [AI_RISK, AI_AGENTS]);
  });

  it("GQ2 — `type:decision pricing` excludes the type:handoff pricing daily (precision=1.0)", async () => {
    const { handlers } = gardenHandlers();
    const r = await callGarden(handlers, "garden_query", {
      query: "type:decision pricing",
    });
    sameSet(r.paths, [PRICING]);
    expect(r.paths).not.toContain(PRICING_DAILY);
  });

  it("GQ3 — `pr7 OR pr8` is the bounded union, pr9 excluded (precision=1.0)", async () => {
    const { handlers } = gardenHandlers();
    const r = await callGarden(handlers, "garden_query", {
      query: "pr7 OR pr8",
    });
    sameSet(r.paths, [PR7, PR8]);
    expect(r.paths).not.toContain(PR9);
  });

  it("GQ4 — `mcp NOT audit` keeps the roadmap, drops the audit handoff + body-only standup (precision=1.0)", async () => {
    const { handlers } = gardenHandlers();
    const r = await callGarden(handlers, "garden_query", {
      query: "mcp NOT audit",
    });
    sameSet(r.paths, [ROADMAP]);
    expect(r.paths).not.toContain(AUDIT_HANDOFF);
    expect(r.paths).not.toContain(STANDUP);
  });

  it("GQ5 — `stripe OR governance OR freemium` surfaces all three single-strong-term gold in top-5", async () => {
    const { handlers } = gardenHandlers();
    const r = await callGarden(handlers, "garden_query", {
      query: "stripe OR governance OR freemium",
    });
    const top5 = r.paths.slice(0, 5);
    for (const g of [PR7, AI_RISK, PRICING]) expect(top5).toContain(g);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// garden_cluster — purity + suggest-then-create (BEHAVIOR bars — RED until §7.5)
// CL4 / G-READONLY is GREEN now (the scaffold writes nothing).
// ═══════════════════════════════════════════════════════════════════════════
describe("Pass 4a — garden_cluster (§4)", () => {
  beforeEach(() => {
    process.env.TAPROOT_GARDEN_CLUSTER = "1";
  });

  it("CL1 — seed=module-1 clusters module-2, excludes pricing + gtm (purity ≥ 0.80)", async () => {
    const { handlers } = gardenHandlers();
    const r = await callGarden(handlers, "garden_cluster", { seed: M1 });
    expect(r.members).toContain(M2);
    expect(purity(r.members, [M2, IS7011_DAILY])).toBeGreaterThanOrEqual(0.8);
    for (const x of [PRICING, ...GTM]) expect(r.members).not.toContain(x);
  });

  it("CL2 — seed=pr7 clusters pr8 + pr9, excludes school notes (purity ≥ 0.80)", async () => {
    const { handlers } = gardenHandlers();
    const r = await callGarden(handlers, "garden_cluster", { seed: PR7 });
    expect(r.members).toContain(PR8);
    expect(r.members).toContain(PR9);
    expect(purity(r.members, [PR8, PR9])).toBeGreaterThanOrEqual(0.8);
    for (const x of [M1, M2]) expect(r.members).not.toContain(x);
  });

  it("CL3 — unseeded surfaces a cluster whose landing-note title overlaps the is-7011 signature", async () => {
    const { handlers } = gardenHandlers();
    const r = await callGarden(handlers, "garden_cluster", {});
    const sig = new Set(["7011", "it", "management", "is"]);
    const overlaps = r.landingTitles.some((t) =>
      t
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .some((tok) => sig.has(tok)),
    );
    expect(overlaps).toBe(true);
  });

  it("CL4 / G-READONLY — clustering never writes/deletes/moves", async () => {
    const { handlers, backend } = gardenHandlers();
    await callGarden(handlers, "garden_cluster", { seed: M1 });
    await callGarden(handlers, "garden_cluster", {});
    expect(backend.writeFile).not.toHaveBeenCalled();
    expect(backend.delete).not.toHaveBeenCalled();
    expect(backend.move).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G-NONREG — registering the primitives does not perturb the Pass 3 path
// (GREEN now: registration only adds Map entries; the shared index/scorer is
// untouched). Sentinel: the Pass 3 control queries stay top-1 with all tools
// registered, both flag states for the new primitives.
// ═══════════════════════════════════════════════════════════════════════════
describe("Pass 4a — G-NONREG: Pass 3 find unperturbed by primitive registration", () => {
  afterEach(() => {
    delete process.env.TAPROOT_RETRIEVAL_V2;
    delete process.env.TAPROOT_GARDEN_IDENTIFIER;
    delete process.env.TAPROOT_GARDEN_QUERY;
    delete process.env.TAPROOT_GARDEN_CLUSTER;
  });

  async function findTop(query: string): Promise<string[]> {
    const { server, registered } = makeServerCapture();
    const backend = corpusBackend();
    registerVaultTools(server, backend);
    registerKnowledgeTools(server, backend);
    registerGardenPrimitives(server, backend);
    const handler = registered.get("garden_find")!;
    h.inserted.length = 0;
    const res = await handler({ query, limit: 10 });
    const text = res.content.map((c) => c.text).join("\n");
    return [...text.matchAll(/^- \*\*.+?\*\* — (\S+\.md)/gm)].map((m) => m[1]);
  }

  for (const flagOn of [false, true]) {
    it(`G1/G2 control queries stay top-1 with primitives ${flagOn ? "ON" : "OFF"} (V2)`, async () => {
      process.env.TAPROOT_RETRIEVAL_V2 = "1";
      if (flagOn) {
        process.env.TAPROOT_GARDEN_IDENTIFIER = "1";
        process.env.TAPROOT_GARDEN_QUERY = "1";
        process.env.TAPROOT_GARDEN_CLUSTER = "1";
      }
      expect((await findTop("garden find hang fix"))[0]).toBe(
        "daily/2026-06/2026-06-01-garden-find-hang-fix-session-a.md",
      );
      expect((await findTop("mcp 7-pass roadmap"))[0]).toBe(ROADMAP);
    });
  }
});
