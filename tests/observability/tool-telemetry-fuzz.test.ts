import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../../src/utils/storage.js";
import { scrubTelemetryEvent } from "../../src/observability/tool-telemetry-scrub.js";

// ─────────────────────────────────────────────────────────────────────────
// Pass 1 observability — fuzz tests (SPEC §6 cases 9-10).
//
// The "no vault content in telemetry" invariant (acceptance criterion 2) is
// the single most important security property of Pass 1: args_shape extractors
// emit only cardinality (ints/bools/coarse enums/hostname), never the query,
// path, title, content, or URL the user actually sent.
//
// DEVIATION FROM SPEC §6.9 TEXT (deliberate, documented):
// The spec prose says "assert no leaf is a string of length > 20". That crude
// length heuristic FALSE-POSITIVES on legitimate non-content fields the matrix
// itself defines: outcome.error_code (e.g. "taproot_save_url_fetch_failed",
// 29 chars), branch_flags.setup_state_bucket ("configured_populated"), and
// args_shape.url_host_only (a hostname — SPEC §5's explicitly-chosen SAFE
// projection). Enforcing it literally would fail on correct code.
//
// Instead we enforce the REAL invariant directly and more strongly:
//   (a) inject recognizable SENTINEL substrings into every string-typed arg,
//       then assert NO sentinel survives into any args_shape/outcome/
//       branch_flags leaf — this catches a refactor that drops query/path/
//       title/content/url into a shape field regardless of length;
//   (b) assert no leaf matches the .md file-path pattern or [[wikilink]]
//       pattern (structural defense-in-depth across all three jsonb blocks);
//   (c) assert args_shape leaves are only number|boolean|null|string, and any
//       string leaf is sentinel-free (so url_host_only/mode pass, content leaks
//       do not).
// This matches SPEC acceptance criterion 2 and the §5 matrix field types with
// zero false positives. See the session handoff for the full rationale.
// ─────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => {
  const inserted: any[] = [];
  const fromMock = vi.fn((_table: string) => ({
    insert: (row: unknown) => {
      inserted.push(row);
      return Promise.resolve({ error: null });
    },
  }));
  const supabaseService = vi.fn(() => ({ from: fromMock }));
  return { inserted, fromMock, supabaseService };
});

vi.mock("../../src/api/supabase.js", () => ({
  supabaseService: h.supabaseService,
  supabaseForUser: vi.fn(),
}));

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

function makeBackend(files: Record<string, string>): StorageBackend {
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
  } as StorageBackend;
}

// Unique, recognizable token that should NEVER appear in any emitted leaf.
const SENTINEL = "SENTINELLEAKZX9";
// A multi-vector poison string crammed into every string-typed arg.
const POISON = `${SENTINEL} password token user@evil.com [[secret-wikilink]] notes/private/secret-${SENTINEL}.md`;
const POISON_PATH = `notes/private/secret-${SENTINEL}.md`;

// Poison args for all 22 tools. Every string field carries a sentinel.
const FUZZ_ARGS: Record<string, Record<string, unknown>> = {
  garden_rules: {},
  garden_read: { path: POISON_PATH },
  garden_plant: { path: POISON_PATH, content: POISON },
  garden_survey: { path: `notes/${SENTINEL}` },
  garden_forage: { query: POISON },
  garden_measure: {},
  garden_tag: { path: POISON_PATH },
  garden_find: { query: POISON },
  garden_recent: { n: 7 },
  garden_delete: { path: POISON_PATH },
  garden_index: {},
  taproot_setup_scan: {},
  taproot_plant: {},
  taproot_till: {
    mode: "custom",
    sourcesFolder: `src-${SENTINEL}`,
    wikiFolder: `wiki-${SENTINEL}`,
    outputsFolder: `out-${SENTINEL}`,
    topic: POISON,
    purpose: "custom",
    purposeDescription: POISON,
  },
  taproot_sow: { topic: POISON },
  taproot_seed: { title: POISON, content: POISON },
  taproot_status: {},
  taproot_water: { sourcePath: POISON_PATH },
  taproot_cultivate: {},
  taproot_harvest: { question: POISON, save: false },
  taproot_prune: {},
  taproot_save_url: {
    url: `https://example.com/${SENTINEL}/secret.md`,
    title: POISON,
    suggestedFolder: `folder-${SENTINEL}`,
    suggestedTags: [POISON],
    userIntent: POISON,
  },
};

const ALL_TOOLS = Object.keys(FUZZ_ARGS);

const MD_PATH_RE = /[/.][a-z0-9-]+\.md/i;
const WIKILINK_RE = /\[\[.+\]\]/;

// Collect every leaf (key, value) pair under a jsonb block.
function leaves(
  value: unknown,
  keyPath = "$",
): { keyPath: string; value: unknown }[] {
  if (value === null || value === undefined) return [{ keyPath, value }];
  if (Array.isArray(value))
    return value.flatMap((v, i) => leaves(v, `${keyPath}[${i}]`));
  if (typeof value === "object")
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      leaves(v, `${keyPath}.${k}`),
    );
  return [{ keyPath, value }];
}

function assertNoLeak(block: unknown, label: string) {
  for (const { keyPath, value } of leaves(block)) {
    if (typeof value !== "string") continue;
    expect(value, `${label}${keyPath} leaks sentinel`).not.toContain(SENTINEL);
    expect(value, `${label}${keyPath} looks like a .md path`).not.toMatch(
      MD_PATH_RE,
    );
    expect(value, `${label}${keyPath} looks like a wikilink`).not.toMatch(
      WIKILINK_RE,
    );
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("TAPROOT_DISABLE_TOOL_RATE_LIMIT", "1");
  h.inserted.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── Test 9: no vault content leaks into any emitted leaf ───────────────────
describe("SPEC §6.9 — no vault content reaches args_shape / outcome / branch_flags", () => {
  for (const tool of ALL_TOOLS) {
    it(`${tool}: poison args produce zero content leakage`, async () => {
      h.inserted.length = 0;
      // Populated backend so success paths set branch_flags; the poison strings
      // are what we trace, not the vault fixture.
      const registered = registerAll(
        makeBackend({
          "CLAUDE.md": "---\ntitle: R\n---\nrules",
          "notes/apple.md":
            "---\ntitle: Apple\ndate_created: 2026-05-01\ntype: note\n---\nbody",
          "sources/article.md":
            "---\ntitle: A\ndate_created: 2026-05-01\ntype: article\n---\nbody",
          "index.md": "# Index\n\n- [[notes/apple]] — apple note",
        }),
        { workspaceId: `ws-fuzz-${tool}` },
      );
      await registered.get(tool)!(FUZZ_ARGS[tool]);
      expect(h.inserted.length).toBeGreaterThanOrEqual(1);

      for (const ev of h.inserted) {
        // args_shape: leaves must be cardinality types; strings sentinel-free.
        for (const { keyPath, value } of leaves(ev.args_shape)) {
          const t = value === null ? "null" : typeof value;
          expect(
            ["number", "boolean", "null", "string"],
            `${tool} args_shape${keyPath} type=${t}`,
          ).toContain(t);
        }
        assertNoLeak(ev.args_shape, `${tool} args_shape`);
        assertNoLeak(ev.branch_flags, `${tool} branch_flags`);
        assertNoLeak(ev.outcome, `${tool} outcome`);
      }
    });
  }
});

// ── Test 10: scrub replaces every strip-list field at every depth ──────────
describe("SPEC §6.10 — scrubTelemetryEvent redacts vault fields at every depth", () => {
  it("replaces `path` (and other strip-list keys) nested in all three jsonb blocks", () => {
    const event = {
      tool_call_id: "id",
      tool: "garden_find",
      kind: "read",
      effect: "read",
      workspace_id: "ws",
      args_shape: {
        path: "notes/secret.md",
        nested: { path: "deep/secret.md", query: "my secret query" },
        arr: [{ content: "leaked body" }, { safe: 3 }],
      },
      outcome: {
        ok: true,
        path: "outcome/secret.md",
        deep: { title: "Secret Title", email: "a@b.com" },
      },
      branch_flags: {
        body_fallback_fired: true,
        url: "https://secret.example.com/x",
        nested: { search_query: "another secret" },
      },
      schema_version: 1,
    };

    const scrubbed = scrubTelemetryEvent(event) as typeof event;

    // Top-level cardinality columns are NEVER scrubbed.
    expect(scrubbed.tool).toBe("garden_find");
    expect(scrubbed.workspace_id).toBe("ws");
    expect(scrubbed.outcome.ok).toBe(true);
    expect(scrubbed.branch_flags.body_fallback_fired).toBe(true);

    // Every strip-list key at every depth → "[REDACTED]".
    expect(scrubbed.args_shape.path).toBe("[REDACTED]");
    expect((scrubbed.args_shape.nested as any).path).toBe("[REDACTED]");
    expect((scrubbed.args_shape.nested as any).query).toBe("[REDACTED]");
    expect((scrubbed.args_shape.arr as any)[0].content).toBe("[REDACTED]");
    expect((scrubbed.args_shape.arr as any)[1].safe).toBe(3);
    expect(scrubbed.outcome.path).toBe("[REDACTED]");
    expect((scrubbed.outcome.deep as any).title).toBe("[REDACTED]");
    expect((scrubbed.outcome.deep as any).email).toBe("[REDACTED]");
    expect(scrubbed.branch_flags.url).toBe("[REDACTED]");
    expect((scrubbed.branch_flags.nested as any).search_query).toBe(
      "[REDACTED]",
    );

    // No strip-list value survives anywhere.
    for (const block of [
      scrubbed.args_shape,
      scrubbed.outcome,
      scrubbed.branch_flags,
    ]) {
      for (const { keyPath, value } of leaves(block)) {
        if (typeof value !== "string") continue;
        expect(value, `${keyPath} should not contain 'secret'`).not.toMatch(
          /secret/i,
        );
      }
    }
  });
});
