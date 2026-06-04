import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../../src/utils/storage.js";
import {
  extractCardinality,
  extractTokens,
} from "../../src/utils/frontmatter.js";
import { PASS4B_CORPUS, FOILS } from "../fixtures/retrieval-pass4b/corpus.js";

// ─────────────────────────────────────────────────────────────────────────
// Pass 4b — garden_cluster family-signal hardening (RED-eval-first).
//
// The Pass 4a cluster passed its fixture bars but the REAL-VAULT smoke
// (2026-06-04) exposed a class of over-merge the small fixture can't show:
// clusterRelated bonds any two notes sharing ANY identifier run len>=2, so
// generic runs collapse the vault — the year `2026` bonded 1009/1479 notes,
// every 2-digit calendar/count number bonded hundreds, and the `is` alpha run
// merged every IS-NNNN course into one blob.
//
// Two NEW behavior bars (RED until the three-gate fix lands):
//   • CL5 — un-merge: no cluster co-locates an IS-7011 note with the is7012
//     foil (alpha-run `is` suppressed when the token carries a real code).
//   • CL6 — calendar guard: three topically-disjoint notes whose only shared
//     signal is the date 2026-05-30 do NOT cluster (year + 2-digit runs are
//     not family signals).
// Plus CL1/CL2/CL3 re-asserted against the extended fixture (no regression).
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

const MD = Object.keys(PASS4B_CORPUS).filter((f) => f.endsWith(".md"));

function corpusBackend(): StorageBackend {
  return {
    readFile: vi.fn(async (p: string) => {
      if (p in PASS4B_CORPUS) return PASS4B_CORPUS[p];
      throw new Error(`not found: ${p}`);
    }),
    writeFile: vi.fn(async () => undefined),
    listFiles: vi.fn(async (sub?: string) =>
      sub ? MD.filter((f) => f === sub || f.startsWith(sub + "/")) : MD,
    ),
    exists: vi.fn(async (p: string) => p in PASS4B_CORPUS),
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
        cardinality: extractCardinality(PASS4B_CORPUS[p]),
        tokens: extractTokens(PASS4B_CORPUS[p]),
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

async function cluster(args: Record<string, unknown>): Promise<string> {
  const r = await handlers().get("garden_cluster")!(args);
  return r.content.map((c) => c.text).join("\n");
}

// Split rendered output into per-cluster member groups (one "## " block each).
function clustersOf(text: string): string[][] {
  return text
    .split(/^## /m)
    .slice(1)
    .map((block) => [...block.matchAll(/^- (\S+\.md)\s*$/gm)].map((m) => m[1]));
}
const allMembers = (text: string): string[] => clustersOf(text).flat();
const landingTitles = (text: string): string[] =>
  [...text.matchAll(/Suggested landing note: `[^`]+` — "([^"]+)"/g)].map(
    (m) => m[1],
  );

const M1 = "school/is-7011-it-management/module-1-it-competitive-advantage.md";
const M2 = "school/is-7011-it-management/module-2-data-governance.md";
const IS7011_DAILY =
  "daily/2026-05/2026-05-17-is7011-case-writeup-1-handoff.md";
const IS7012_NOTE = "daily/2026-05/2026-05-26-is7012-new-course.md";
const PR7 = "daily/2026-05/2026-05-21-pr7-stripe-webhook-shipped.md";
const PR8 = "daily/2026-05/2026-05-22-pr8-oauth-fix.md";
const PR9 = "daily/2026-05/2026-05-23-pr9-telemetry-wrapper.md";
const IS7011_FAMILY = [M1, M2, IS7011_DAILY];

const purity = (members: string[], gold: string[]) =>
  members.length === 0
    ? 0
    : members.filter((m) => gold.includes(m)).length / members.length;

beforeEach(() => {
  process.env.TAPROOT_GARDEN_CLUSTER = "1";
});
afterEach(() => {
  delete process.env.TAPROOT_GARDEN_CLUSTER;
});

describe("Pass 4b — garden_cluster family-signal hardening", () => {
  it("CL5 — unseeded: no cluster co-locates an IS-7011 note with the is7012 foil (alpha-run un-merge)", async () => {
    const text = await cluster({});
    for (const group of clustersOf(text)) {
      const hasFamily = group.some((p) => IS7011_FAMILY.includes(p));
      if (hasFamily) expect(group).not.toContain(IS7012_NOTE);
    }
  });

  it("CL6 — unseeded: calendar-only foils (shared 2026-05-30) never cluster", async () => {
    const members = allMembers(await cluster({}));
    for (const foil of FOILS) expect(members).not.toContain(foil);
  });

  it("CL6b — seeded on a calendar foil yields no related notes", async () => {
    const text = await cluster({ seed: FOILS[0] });
    expect(text).toMatch(/No related notes/i);
  });

  // ── Regression: Pass 4a cluster bars hold on the extended fixture ──
  it("CL1 (regress) — seed=module-1 clusters module-2, excludes is7012 (purity ≥ 0.80)", async () => {
    const members = clustersOf(await cluster({ seed: M1 })).flat();
    expect(members).toContain(M2);
    expect(purity(members, [M2, IS7011_DAILY])).toBeGreaterThanOrEqual(0.8);
    expect(members).not.toContain(IS7012_NOTE);
  });

  it("CL2 (regress) — seed=pr7 clusters pr8 + pr9 (the `pr` family survives)", async () => {
    const members = clustersOf(await cluster({ seed: PR7 })).flat();
    expect(members).toContain(PR8);
    expect(members).toContain(PR9);
    expect(purity(members, [PR8, PR9])).toBeGreaterThanOrEqual(0.8);
  });

  it("CL3 (regress) — unseeded surfaces an is-7011-signature landing title", async () => {
    const sig = new Set(["7011", "it", "management", "is"]);
    const overlaps = landingTitles(await cluster({})).some((t) =>
      t
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .some((tok) => sig.has(tok)),
    );
    expect(overlaps).toBe(true);
  });
});
