import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../../src/utils/storage.js";

// ─────────────────────────────────────────────────────────────────────────
// Pass 1 observability — wrapper acceptance tests (SPEC §6 cases 1-8).
//
// Reference: projects/taproot/build/2026-05-28-mcp-pass-1-spec-draft.md §6
//   + plan-supplement §8 (amendments A1-A9, the LAST WORD on the contract).
//
// SEAM. The telemetry write path is real (src/utils/supabase-telemetry.ts →
// real scrub + real kill switch). Only src/api/supabase.ts:supabaseService is
// mocked, returning a controllable fake client that captures the POST-SCRUB
// row synchronously. This is the seam the 2026-05-28 handoff locked: the
// kill-switch test asserts "no supabase call" by spying on the client, not by
// inspecting wrapper internals.
//
// CONTRACT being asserted (the design call the handoff flagged for scrutiny):
// the wrapper does NOT synthesize error_code from a re-thrown exception —
// handlers catch internally and return respondToolError(...), so the wrapper
// detects isError on the returned response and reads the handler-supplied
// ctx.errorCode. Every error assertion below targets the EMITTED
// outcome.error_code, which is also what makes these tests the drift-guard.
// ─────────────────────────────────────────────────────────────────────────

// Hoisted capture harness — referenced by the vi.mock factory below.
const h = vi.hoisted(() => {
  const inserted: any[] = [];
  const state = { throwOnInsert: false, rejectOnInsert: false };
  const fromMock = vi.fn((_table: string) => ({
    insert: (row: unknown) => {
      if (state.throwOnInsert) throw new Error("supabase insert boom");
      if (state.rejectOnInsert)
        return Promise.reject(new Error("supabase network down"));
      inserted.push(row);
      return Promise.resolve({ error: null });
    },
  }));
  const supabaseService = vi.fn(() => ({ from: fromMock }));
  return { inserted, state, fromMock, supabaseService };
});

vi.mock("../../src/api/supabase.js", () => ({
  supabaseService: h.supabaseService,
  supabaseForUser: vi.fn(),
}));

// Avoid real network for the URL tools. taproot_save_url requires a url;
// taproot_seed happy-path uses content (no fetch). Spread importActual so the
// fetch module's other exports (validateUrl, assertNotPrivate) are untouched.
vi.mock("../../src/utils/fetch.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/utils/fetch.js")>();
  return {
    ...actual,
    fetchUrlAsText: vi.fn(async (rawUrl: string) => ({
      url: rawUrl,
      title: "Fetched Title",
      body: "fetched body text",
      contentType: "text/html",
    })),
  };
});

import { registerRulesTool } from "../../src/tools/rules.js";
import { registerVaultTools } from "../../src/tools/vault.js";
import { registerIndexTool } from "../../src/tools/index-tool.js";
import { registerInitTools } from "../../src/tools/init.js";
import { registerKnowledgeTools } from "../../src/tools/knowledge.js";

type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

interface TelemetryEvent {
  tool_call_id: string;
  tool: string;
  kind: string;
  effect: string;
  workspace_id: string | null;
  args_shape: Record<string, unknown> | null;
  outcome: {
    ok: boolean;
    latency_ms: number;
    result_count: number;
    no_results: boolean;
    error_code: string | null;
    rate_limited: boolean;
  };
  branch_flags: Record<string, unknown> | null;
  schema_version: number;
}

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

function registerAll(
  backend: StorageBackend,
  opts: { workspaceId?: string } = {},
): Map<string, ToolHandler> {
  const { server, registered } = makeServerCapture();
  registerRulesTool(server, backend, opts);
  registerVaultTools(server, backend, opts);
  registerIndexTool(server, backend, opts);
  registerInitTools(server, backend, opts);
  registerKnowledgeTools(server, backend, opts);
  return registered;
}

// Backend that serves a fixed Record<path, content>. listFiles + exists honor
// folder prefixes; listFilesMeta derives null cardinalities (exercises the
// backfill path harmlessly). Mirrors tests/tools/harvest.test.ts conventions.
function makeBackend(
  files: Record<string, string>,
  overrides: Partial<StorageBackend> = {},
): StorageBackend {
  const writes: Record<string, string> = {};
  const allMd = () =>
    [...new Set([...Object.keys(files), ...Object.keys(writes)])].filter((f) =>
      f.endsWith(".md"),
    );
  const read = (p: string) => (p in writes ? writes[p] : files[p]);
  return {
    readFile: vi.fn(async (p: string) => {
      const c = read(p);
      if (c === undefined) throw new Error(`not found: ${p}`);
      return c;
    }),
    writeFile: vi.fn(async (p: string, c: string) => {
      writes[p] = c;
    }),
    listFiles: vi.fn(async (subPath?: string) => {
      const all = allMd();
      if (!subPath) return all;
      return all.filter((f) => f === subPath || f.startsWith(subPath + "/"));
    }),
    exists: vi.fn(async (p: string) => {
      if (p in files || p in writes) return true;
      return allMd().some((f) => f.startsWith(p + "/"));
    }),
    mkdir: vi.fn(async () => undefined),
    delete: vi.fn(async (p: string) => {
      delete writes[p];
    }),
    move: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: 0, modifiedAt: new Date() })),
    recentFiles: vi.fn(async () => allMd()),
    listChanged: vi.fn(async () => ({
      files: [],
      next: null,
      pendingCount: 0,
    })),
    getCursorHead: vi.fn(async () => null),
    getPendingCount: vi.fn(async () => 0),
    listFilesMeta: vi.fn(async (subPath?: string) => {
      const all = allMd();
      const scoped = subPath
        ? all.filter((f) => f === subPath || f.startsWith(subPath + "/"))
        : all;
      return scoped.map((path) => ({ path, cardinality: null }));
    }),
    batchUpdateCardinalities: vi.fn(async () => undefined),
    ...overrides,
  } as StorageBackend;
}

// Every backend method rejects — drives every tool down its error path.
function makeThrowingBackend(): StorageBackend {
  const boom = async () => {
    throw new Error("backend boom");
  };
  return {
    readFile: vi.fn(boom),
    writeFile: vi.fn(boom),
    listFiles: vi.fn(boom),
    exists: vi.fn(boom),
    mkdir: vi.fn(boom),
    delete: vi.fn(boom),
    move: vi.fn(boom),
    stat: vi.fn(boom),
    recentFiles: vi.fn(boom),
    listChanged: vi.fn(boom),
    getCursorHead: vi.fn(boom),
    getPendingCount: vi.fn(boom),
    listFilesMeta: vi.fn(boom),
    batchUpdateCardinalities: vi.fn(boom),
  } as unknown as StorageBackend;
}

const HAPPY_FILES: Record<string, string> = {
  "CLAUDE.md": "---\ntitle: Rules\n---\n# Filing rules\n\nbody text",
  "notes/apple.md":
    "---\ntitle: Apple\ntags: [fruit]\ndate_created: 2026-05-01\ntype: note\n---\n\nApple body text about apple fruit.",
  "sources/article.md":
    "---\ntitle: Article\ndate_created: 2026-05-01\ntype: article\n---\n\nSource body content.",
  // No TAPROOT-MANAGED marker + no date → garden_index synthesizes (exercises
  // the served_synthesized branch). Index line is parseable by parseIndexCandidates.
  "index.md": "# Index\n\n- [[notes/apple]] — apple fruit note",
};

// All 22 registered tool names — the coverage gate.
const ALL_TOOLS = [
  "garden_rules",
  "garden_read",
  "garden_plant",
  "garden_survey",
  "garden_forage",
  "garden_measure",
  "garden_tag",
  "garden_find",
  "garden_recent",
  "garden_delete",
  "garden_index",
  "taproot_setup_scan",
  "taproot_plant",
  "taproot_till",
  "taproot_sow",
  "taproot_seed",
  "taproot_status",
  "taproot_water",
  "taproot_cultivate",
  "taproot_harvest",
  "taproot_prune",
  "taproot_save_url",
];

// Happy-path args that genuinely succeed against HAPPY_FILES (+ mocked fetch).
const HAPPY_ARGS: Record<string, Record<string, unknown>> = {
  garden_rules: {},
  garden_read: { path: "notes/apple.md" },
  garden_plant: { path: "notes/new-note.md", content: "# New" },
  garden_survey: {},
  garden_forage: { query: "apple" },
  garden_measure: {},
  garden_tag: { path: "notes/apple.md" },
  garden_find: { query: "apple" },
  garden_recent: { n: 5 },
  garden_delete: { path: "notes/apple.md" },
  garden_index: {},
  taproot_setup_scan: {},
  taproot_plant: {},
  taproot_till: { mode: "existing" },
  taproot_sow: { topic: "test topic" },
  taproot_seed: { title: "My Note", content: "hello content body" },
  taproot_status: {},
  taproot_water: { sourcePath: "sources/article.md" },
  taproot_cultivate: {},
  taproot_harvest: { question: "what about apple fruit notes", save: false },
  taproot_prune: {},
  taproot_save_url: { url: "https://example.com/page", previewOnly: true },
};

// For the error path: a few tools' happy args don't touch the backend's
// failing surface (taproot_save_url previewOnly returns before any write, and
// fetch is mocked to succeed). Override so every tool genuinely errors.
const ERROR_ARGS: Record<string, Record<string, unknown>> = {
  ...HAPPY_ARGS,
  taproot_save_url: { url: "https://example.com/page" }, // no previewOnly → writes → throws
};

const lastEvent = (): TelemetryEvent =>
  h.inserted[h.inserted.length - 1] as TelemetryEvent;

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  // Rate limiting OFF by default so it never interferes with emit-capture
  // tests; test 6 re-enables it explicitly with a unique workspace.
  vi.stubEnv("TAPROOT_DISABLE_TOOL_RATE_LIMIT", "1");
  // Telemetry ON (default). The kill-switch test (7) flips it to "0".
  h.inserted.length = 0;
  h.state.throwOnInsert = false;
  h.state.rejectOnInsert = false;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── Test 1: every tool emits — 22 happy + 22 error = 44 ────────────────────
describe("SPEC §6.1 — every tool emits one event per call", () => {
  it("emits exactly one ok:true event on the happy path for all 22 tools", async () => {
    for (const tool of ALL_TOOLS) {
      h.inserted.length = 0;
      const registered = registerAll(makeBackend(HAPPY_FILES), {
        workspaceId: `ws-happy-${tool}`,
      });
      const handler = registered.get(tool);
      expect(handler, `handler registered for ${tool}`).toBeDefined();

      const res = await handler!(HAPPY_ARGS[tool]);
      expect(h.inserted, `${tool} emitted exactly one event`).toHaveLength(1);
      const ev = lastEvent();
      expect(ev.tool, `${tool} event.tool`).toBe(tool);
      expect(
        ev.outcome.ok,
        `${tool} happy outcome.ok (resp.isError=${res.isError})`,
      ).toBe(true);
      expect(ev.outcome.error_code, `${tool} happy error_code`).toBeNull();
      expect(ev.outcome.rate_limited).toBe(false);
      expect(typeof ev.tool_call_id).toBe("string");
      expect(ev.schema_version).toBe(1);
    }
  });

  it("emits exactly one ok:false event on the error path for all 22 tools", async () => {
    for (const tool of ALL_TOOLS) {
      h.inserted.length = 0;
      const registered = registerAll(makeThrowingBackend(), {
        workspaceId: `ws-err-${tool}`,
      });
      const handler = registered.get(tool)!;

      const res = await handler(ERROR_ARGS[tool]);
      expect(res.isError, `${tool} returns isError on throwing backend`).toBe(
        true,
      );
      expect(
        h.inserted,
        `${tool} emitted exactly one error event`,
      ).toHaveLength(1);
      const ev = lastEvent();
      expect(ev.tool, `${tool} error event.tool`).toBe(tool);
      expect(ev.outcome.ok, `${tool} error outcome.ok`).toBe(false);
      expect(ev.outcome.error_code, `${tool} error_code present`).toBeTruthy();
    }
  });

  it("covers exactly the 22 canonical tools (no more, no fewer)", () => {
    const registered = registerAll(makeBackend(HAPPY_FILES));
    expect([...registered.keys()].sort()).toEqual([...ALL_TOOLS].sort());
  });
});

// ── Test 2: canonical tool name + drift-guard on error_code ────────────────
describe("SPEC §6.2 — drift tools emit canonical name + canonical error_code", () => {
  // The 5 catch codes the migration corrected. error_code must be the
  // canonical <tool>_failed, NEVER the legacy drifted name.
  const DRIFT: { tool: string; canonicalCode: string; legacyCode: string }[] = [
    {
      tool: "garden_forage",
      canonicalCode: "garden_forage_failed",
      legacyCode: "garden_find_failed",
    },
    {
      tool: "garden_measure",
      canonicalCode: "garden_measure_failed",
      legacyCode: "garden_stats_failed",
    },
    {
      tool: "garden_tag",
      canonicalCode: "garden_tag_failed",
      legacyCode: "garden_frontmatter_failed",
    },
    {
      tool: "garden_find",
      canonicalCode: "garden_find_failed",
      legacyCode: "garden_search_failed",
    },
    {
      tool: "taproot_sow",
      canonicalCode: "taproot_sow_failed",
      legacyCode: "taproot_init_failed",
    },
  ];

  for (const { tool, canonicalCode, legacyCode } of DRIFT) {
    it(`${tool}: event.tool canonical, error_code=${canonicalCode} (not ${legacyCode})`, async () => {
      const registered = registerAll(makeThrowingBackend(), {
        workspaceId: `ws-drift-${tool}`,
      });
      const res = await registered.get(tool)!(HAPPY_ARGS[tool]);
      expect(res.isError).toBe(true);
      const ev = lastEvent();
      expect(ev.tool).toBe(tool);
      expect(ev.outcome.ok).toBe(false);
      expect(ev.outcome.error_code).toBe(canonicalCode);
      expect(ev.outcome.error_code).not.toBe(legacyCode);
    });
  }
});

// ── Test 3: no_results correctness ─────────────────────────────────────────
describe("SPEC §6.3 — no_results reflects empty vs non-empty results", () => {
  // Matrix §5 lists 9 tools with a no_results condition (SPEC test 3 prose
  // says "7" — stale; we test all 9). Each: empty-condition → true.
  const EMPTY_CASES: { tool: string; args: Record<string, unknown> }[] = [
    { tool: "garden_survey", args: {} },
    { tool: "garden_forage", args: { query: "zzznomatchqqq" } },
    { tool: "garden_find", args: { query: "zzznomatchqqq" } },
    { tool: "garden_recent", args: { n: 5 } },
    { tool: "garden_index", args: {} },
    { tool: "taproot_cultivate", args: {} },
    { tool: "taproot_prune", args: {} },
    {
      tool: "taproot_harvest",
      args: { question: "zzznomatchqqq topic", save: false },
    },
  ];

  for (const { tool, args } of EMPTY_CASES) {
    it(`${tool}: empty vault → no_results=true`, async () => {
      const registered = registerAll(makeBackend({}), {
        workspaceId: `ws-empty-${tool}`,
      });
      const res = await registered.get(tool)!(args);
      expect(res.isError).toBeFalsy();
      expect(lastEvent().outcome.no_results, `${tool} no_results`).toBe(true);
    });
  }

  it("garden_tag: file with no frontmatter → no_results=true", async () => {
    const registered = registerAll(
      makeBackend({ "notes/plain.md": "just a body, no frontmatter" }),
      { workspaceId: "ws-tag-empty" },
    );
    const res = await registered.get("garden_tag")!({ path: "notes/plain.md" });
    expect(res.isError).toBeFalsy();
    expect(lastEvent().outcome.no_results).toBe(true);
  });

  // Non-empty side: populated vault → no_results=false for the same tools.
  const NONEMPTY_CASES: { tool: string; args: Record<string, unknown> }[] = [
    { tool: "garden_survey", args: {} },
    { tool: "garden_forage", args: { query: "apple" } },
    { tool: "garden_find", args: { query: "apple" } },
    { tool: "garden_recent", args: { n: 5 } },
    { tool: "garden_index", args: {} },
    { tool: "taproot_prune", args: {} },
    { tool: "garden_tag", args: { path: "notes/apple.md" } },
    {
      tool: "taproot_harvest",
      args: { question: "what about apple fruit", save: false },
    },
  ];

  for (const { tool, args } of NONEMPTY_CASES) {
    it(`${tool}: populated vault → no_results=false`, async () => {
      const registered = registerAll(makeBackend(HAPPY_FILES), {
        workspaceId: `ws-pop-${tool}`,
      });
      const res = await registered.get(tool)!(args);
      expect(res.isError).toBeFalsy();
      expect(lastEvent().outcome.no_results, `${tool} no_results`).toBe(false);
    });
  }
});

// ── Test 4: garden_find.body_fallback_fired (vault.ts:746 boundary) ────────
describe("SPEC §6.4 — garden_find.body_fallback_fired", () => {
  it("(a) filename hit → fallback NOT fired", async () => {
    const registered = registerAll(makeBackend(HAPPY_FILES), {
      workspaceId: "ws-bf-a",
    });
    const res = await registered.get("garden_find")!({ query: "apple" });
    expect(res.isError).toBeFalsy();
    const flags = lastEvent().branch_flags!;
    expect(flags.body_fallback_fired).toBe(false);
    expect(flags.filename_hits).toBeGreaterThan(0);
    expect(lastEvent().outcome.no_results).toBe(false);
  });

  it("(b) zero filename hits → fallback fired (body search runs)", async () => {
    // basename never matches "needle", but a body DOES contain it → fallback
    // fires AND finds a hit, so body_fallback_fired=true with results.
    const registered = registerAll(
      makeBackend({
        "notes/zebra.md":
          "---\ntitle: Zebra\n---\n\nthis body mentions needle once",
      }),
      { workspaceId: "ws-bf-b" },
    );
    const res = await registered.get("garden_find")!({ query: "needle" });
    expect(res.isError).toBeFalsy();
    const flags = lastEvent().branch_flags!;
    expect(flags.filename_hits).toBe(0);
    expect(flags.body_fallback_fired).toBe(true);
    expect(flags.body_hits).toBe(1);
  });

  it("(c) zero filename hits AND empty body search → fallback fired, no_results=true", async () => {
    const registered = registerAll(
      makeBackend({
        "notes/zebra.md": "---\ntitle: Zebra\n---\n\nunrelated body",
      }),
      { workspaceId: "ws-bf-c" },
    );
    const res = await registered.get("garden_find")!({ query: "needle" });
    expect(res.isError).toBeFalsy();
    const flags = lastEvent().branch_flags!;
    expect(flags.filename_hits).toBe(0);
    expect(flags.body_fallback_fired).toBe(true);
    expect(flags.body_hits).toBe(0);
    expect(lastEvent().outcome.no_results).toBe(true);
  });
});

// ── Test 5: taproot_harvest.scoring_path (knowledge.ts:879 boundary, A2) ───
describe("SPEC §6.5 — taproot_harvest.scoring_path", () => {
  it('(a) index has scored candidates → "index"', async () => {
    const registered = registerAll(
      makeBackend({
        "index.md": "# Index\n\n- [[notes/apple]] — apple fruit deep dive",
        "notes/apple.md": "---\ntitle: Apple\n---\n\napple body",
      }),
      { workspaceId: "ws-sp-a" },
    );
    const res = await registered.get("taproot_harvest")!({
      question: "tell me about apple fruit",
      save: false,
    });
    expect(res.isError).toBeFalsy();
    expect(lastEvent().branch_flags!.scoring_path).toBe("index");
  });

  it('(b) zero index hits → "body" fallback', async () => {
    // index.md present but its entries score 0 against the keywords → body branch.
    const registered = registerAll(
      makeBackend({
        "index.md":
          "# Index\n\n- [[notes/zebra]] — something unrelated entirely",
        "notes/zebra.md": "---\ntitle: Zebra\n---\n\nzebra body apple fruit",
      }),
      { workspaceId: "ws-sp-b" },
    );
    const res = await registered.get("taproot_harvest")!({
      question: "tell me about apple fruit",
      save: false,
    });
    expect(res.isError).toBeFalsy();
    expect(lastEvent().branch_flags!.scoring_path).toBe("body");
  });

  it('(c) empty / absent index → "body" fallback', async () => {
    const registered = registerAll(
      makeBackend({
        "notes/apple.md": "---\ntitle: Apple\n---\n\napple fruit body",
      }),
      { workspaceId: "ws-sp-c" },
    );
    const res = await registered.get("taproot_harvest")!({
      question: "tell me about apple fruit",
      save: false,
    });
    expect(res.isError).toBeFalsy();
    expect(lastEvent().branch_flags!.scoring_path).toBe("body");
  });

  // NOTE on the null case (A2): scoring_path stays null only if withTimeout
  // cancels hotPath() BEFORE the synchronous scoringPath assignment. Since the
  // assignment runs synchronously (no await precedes it inside hotPath), the
  // 15s budget cannot preempt it in a deterministic unit test — null is the
  // truthful default under a real mid-flight timeout and is exercised by the
  // soak/integration path, not here. SPEC §6.5 specifies index/body/body.
});

// ── Test 6: rate-limit emit ────────────────────────────────────────────────
describe("SPEC §6.6 — rate-limited call emits ok:false, rate_limited:true", () => {
  it("emits a rate_limited event with latency_ms < 5 when the bucket is full", async () => {
    vi.unstubAllEnvs(); // re-enable the real limiter for this test only
    const registered = registerAll(makeBackend(HAPPY_FILES), {
      workspaceId: `ws-rl-${Date.now()}`,
    });
    const handler = registered.get("garden_plant")!; // write cap = 30/min

    // Fill the bucket (30 allowed writes).
    for (let i = 0; i < 30; i++) {
      const r = await handler({ path: `notes/n${i}.md`, content: "x" });
      expect(r.isError).not.toBe(true);
    }
    const before = h.inserted.length;

    // 31st call is denied by the limiter — handler never runs.
    const denied = await handler({ path: "notes/n31.md", content: "x" });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toMatch(/Rate limit/i);

    expect(h.inserted.length).toBe(before + 1);
    const ev = lastEvent();
    expect(ev.tool).toBe("garden_plant");
    expect(ev.outcome.ok).toBe(false);
    expect(ev.outcome.rate_limited).toBe(true);
    expect(ev.outcome.error_code).toBe("rate_limited");
    expect(ev.outcome.latency_ms).toBeLessThan(5);
  });
});

// ── Test 7: kill switch ────────────────────────────────────────────────────
describe("SPEC §6.7 — TAPROOT_TOOL_TELEMETRY=0 makes zero supabase calls", () => {
  it("mints ctx + runs the handler but never touches the supabase client", async () => {
    vi.stubEnv("TAPROOT_TOOL_TELEMETRY", "0");
    const registered = registerAll(makeBackend(HAPPY_FILES), {
      workspaceId: "ws-kill",
    });
    const res = await registered.get("garden_find")!({ query: "apple" });

    // Handler still returns a normal response (wrapper not bypassed).
    expect(res.isError).toBeFalsy();
    // But the emit path short-circuits before the network round-trip.
    expect(h.supabaseService).not.toHaveBeenCalled();
    expect(h.fromMock).not.toHaveBeenCalled();
    expect(h.inserted).toHaveLength(0);
  });
});

// ── Test 8: throw isolation ────────────────────────────────────────────────
describe("SPEC §6.8 — a throwing insert never reaches the caller", () => {
  it("tool response is unchanged and no exception propagates when insert throws", async () => {
    // Baseline (insert works): capture the exact happy response bytes.
    const okRegistered = registerAll(makeBackend(HAPPY_FILES), {
      workspaceId: "ws-iso-ok",
    });
    const okRes = await okRegistered.get("garden_read")!({
      path: "notes/apple.md",
    });

    // Discard the baseline emit, then make the supabase insert throw.
    h.inserted.length = 0;
    h.state.throwOnInsert = true;
    const registered = registerAll(makeBackend(HAPPY_FILES), {
      workspaceId: "ws-iso-throw",
    });

    let res: any;
    await expect(
      (async () => {
        res = await registered.get("garden_read")!({ path: "notes/apple.md" });
      })(),
    ).resolves.toBeUndefined();

    // emit() swallowed the throw; the supabase client WAS reached (so we know
    // we exercised the failing insert), nothing was captured, response intact.
    // (garden_read embeds a random fence nonce per call, so the two responses
    // are never byte-identical — assert on the structure + vault content.)
    expect(h.supabaseService).toHaveBeenCalled();
    expect(h.inserted).toHaveLength(0);
    expect(okRes.isError).toBeFalsy();
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Apple body text about apple fruit.");
  });

  // Pre-deploy review finding (2026-05-31): the fire-and-forget insert had a
  // .then() but no .catch(). supabase-js folds query errors into `error`, but
  // a network-layer failure rejects the promise — which, with no .catch() and
  // no global handler, is an unhandled rejection that terminates the process
  // on Node >=18. Test 8 above only covers a SYNCHRONOUS throw (caught by
  // emit()'s try/catch); this covers the ASYNC rejection path the fix added a
  // .catch() for. Telemetry must never take down the product.
  it("a rejected insert promise does not surface or raise an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      h.state.rejectOnInsert = true;
      const registered = registerAll(makeBackend(HAPPY_FILES), {
        workspaceId: "ws-iso-reject",
      });

      const res = await registered.get("garden_read")!({
        path: "notes/apple.md",
      });

      // Let the rejected fire-and-forget promise settle before we assert.
      await new Promise((r) => setTimeout(r, 20));

      // The .catch() swallowed the rejection — none escaped to the process.
      expect(h.supabaseService).toHaveBeenCalled();
      expect(unhandled).toHaveLength(0);
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain(
        "Apple body text about apple fruit.",
      );
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

// ── Test 9: bounded-scan flags (files_scanned + scan_capped) ───────────────
describe("SPEC §6.9 — garden_find + garden_forage emit bounded-scan flags", () => {
  const manyNoMatch = (): Record<string, string> => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) {
      files[`notes/x${i}.md`] = "no relevant body content in this note";
    }
    return files;
  };

  it("garden_find capped no-match fallback emits files_scanned + scan_capped (additive)", async () => {
    vi.stubEnv("SCAN_FILE_CAP", "10");
    const registered = registerAll(makeBackend(manyNoMatch()), {
      workspaceId: "ws-scan-find",
    });
    const res = await registered.get("garden_find")!({
      query: "zzznomatchqqq",
    });
    expect(res.isError).toBeFalsy();
    const flags = lastEvent().branch_flags!;
    expect(typeof flags.files_scanned).toBe("number");
    expect(flags.files_scanned as number).toBeLessThanOrEqual(10);
    expect(typeof flags.scan_capped).toBe("boolean");
    expect(flags.scan_capped).toBe(true);
    // Existing flags preserved (additive, not replaced).
    expect(flags.body_fallback_fired).toBe(true);
    expect(flags.filename_hits).toBe(0);
  });

  it("garden_forage emits files_scanned + scan_capped alongside its existing flags", async () => {
    vi.stubEnv("SCAN_FILE_CAP", "10");
    const registered = registerAll(makeBackend(manyNoMatch()), {
      workspaceId: "ws-scan-forage",
    });
    const res = await registered.get("garden_forage")!({
      query: "zzznomatchqqq",
    });
    expect(res.isError).toBeFalsy();
    const flags = lastEvent().branch_flags!;
    expect(typeof flags.files_scanned).toBe("number");
    expect(typeof flags.scan_capped).toBe("boolean");
    expect(flags).toHaveProperty("partial_results");
    expect(flags).toHaveProperty("priority_hints_count");
  });
});
