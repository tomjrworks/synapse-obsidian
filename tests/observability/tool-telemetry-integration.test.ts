import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../../src/utils/storage.js";
import { registerVaultTools } from "../../src/tools/vault.js";
import { supabaseService } from "../../src/api/supabase.js";

// ─────────────────────────────────────────────────────────────────────────
// Pass 1 observability — integration test (SPEC §6 case 11).
//
// End-to-end: fire garden_find through the REAL wrapper (no mocks) → the real
// fire-and-forget insert → query the live tool_call_events table → assert the
// persisted row matches the expected shape. Validates the write path is wired.
//
// GATED. Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY pointing at a DB
// where migration 0029_tool_call_events.sql has been applied — `supabase
// start` locally OR the TEST project (PLAN supplement §2 gate 3 / §5 step 4).
// Skips cleanly when env is absent so `npm test` stays green without a DB.
// This is the deploy-time check, not a unit test — do not mock the client.
// ─────────────────────────────────────────────────────────────────────────

const HAS_DB =
  !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

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

// Minimal empty backend → garden_find with any query yields zero results, so
// the persisted row should carry outcome.no_results = true (mirrors gate 9).
function makeEmptyBackend(): StorageBackend {
  return {
    readFile: vi.fn(async () => {
      throw new Error("empty");
    }),
    writeFile: vi.fn(async () => undefined),
    listFiles: vi.fn(async () => []),
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
    listFilesMeta: vi.fn(async () => []),
    batchUpdateCardinalities: vi.fn(async () => undefined),
  } as StorageBackend;
}

// Unique per-run workspace id so the SELECT finds exactly our row(s).
const WS = `it-telemetry-${process.pid}-${Date.now()}`;

describe.skipIf(!HAS_DB)("SPEC §6.11 — end-to-end emit → row", () => {
  beforeAll(() => {
    // Ensure telemetry + rate limiting are in their default (on/normal) state.
    delete process.env.TAPROOT_TOOL_TELEMETRY;
  });

  afterAll(async () => {
    // Best-effort cleanup of the rows this run inserted.
    try {
      await supabaseService()
        .from("tool_call_events")
        .delete()
        .eq("workspace_id", WS);
    } catch {
      /* leave rows if cleanup fails — they're harmless test data */
    }
  });

  it("persists one garden_find row with the expected shape and no_results=true", async () => {
    const { server, registered } = makeServerCapture();
    registerVaultTools(server, makeEmptyBackend(), { workspaceId: WS });
    const handler = registered.get("garden_find")!;

    const res = await handler({ query: "xyzqwertynothing" });
    expect(res.isError).toBeFalsy();

    // Insert is fire-and-forget — poll the table until our row lands.
    const client = supabaseService();
    let rows: any[] = [];
    for (let attempt = 0; attempt < 20 && rows.length === 0; attempt++) {
      await new Promise((r) => setTimeout(r, 250));
      const { data, error } = await client
        .from("tool_call_events")
        .select("*")
        .eq("workspace_id", WS)
        .eq("tool", "garden_find");
      if (error) throw new Error(`select failed: ${error.message}`);
      rows = data ?? [];
    }

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0];
    expect(row.tool).toBe("garden_find");
    expect(row.kind).toBe("read");
    expect(row.effect).toBe("read");
    expect(row.workspace_id).toBe(WS);
    expect(row.schema_version).toBe(1);
    expect(typeof row.tool_call_id).toBe("string");
    // outcome jsonb
    expect(row.outcome.ok).toBe(true);
    expect(row.outcome.no_results).toBe(true);
    expect(row.outcome.rate_limited).toBe(false);
    expect(row.outcome.error_code).toBeNull();
    // args_shape carries cardinality only — no query text.
    expect(JSON.stringify(row.args_shape)).not.toContain("xyzqwertynothing");
    expect(row.args_shape.query_len).toBe("xyzqwertynothing".length);
  });
});

// When env is absent, surface why the e2e didn't run (visible in test output).
describe.skipIf(HAS_DB)("SPEC §6.11 — skipped (no Supabase env)", () => {
  it("documents the skip reason", () => {
    expect(HAS_DB).toBe(false);
    // Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (supabase start or TEST
    // project with migration 0029 applied) to run the e2e write-path check.
  });
});
