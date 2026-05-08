import { describe, it, expect, beforeEach, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerVaultTools } from "../../src/tools/vault.js";
import { registerKnowledgeTools } from "../../src/tools/knowledge.js";
import type { StorageBackend } from "../../src/utils/storage.js";

// ---------------------------------------------------------------------------
// Smoke for Phase 5 per-tool rate limit wrapper (H11).
//
// Tests that:
// 1. A write tool (garden_plant) 429s after hitting the 30/min cap.
// 2. A read tool (garden_read) 429s after hitting the 120/min cap.
// 3. Buckets are workspace-scoped — a second workspaceId is independent.
// 4. TAPROOT_DISABLE_TOOL_RATE_LIMIT=1 bypasses the limit.
// ---------------------------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function makeServerCapture(): {
  server: McpServer;
  registered: Map<string, ToolHandler>;
} {
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

function makeBackend(): StorageBackend {
  return {
    readFile: vi.fn(async () => "---\ntitle: test\n---\n\nbody"),
    writeFile: vi.fn(async () => undefined),
    listFiles: vi.fn(async () => []),
    exists: vi.fn(async () => false),
    mkdir: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: 0, modifiedAt: new Date() })),
    recentFiles: vi.fn(async () => []),
    listChanged: vi.fn(async () => ({ files: [], next: null })),
  } as StorageBackend;
}

describe("per-tool rate limits (H11)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    // Each test gets a fresh module-level bucket state by using a unique workspaceId.
  });

  it("write tool (garden_plant) returns isError:true after cap+1 calls", async () => {
    const { server, registered } = makeServerCapture();
    const wsId = `ws-write-${Date.now()}-${Math.random()}`;
    registerVaultTools(server, makeBackend(), { workspaceId: wsId });

    const handler = registered.get("garden_plant")!;
    expect(handler).toBeDefined();

    // Hit the 30/min write cap
    for (let i = 0; i < 30; i++) {
      const res = await handler({
        path: "notes/test.md",
        content: "# test",
      });
      // Should succeed (may error for other reasons like file write, but not rate-limit)
      expect(res.isError).not.toBe(true);
    }

    // 31st call should be rate-limited
    const res31 = await handler({
      path: "notes/test.md",
      content: "# test",
    });
    expect(res31.isError).toBe(true);
    expect(res31.content[0].text).toMatch(/Rate limit/i);
  });

  it("read tool (garden_read) returns isError:true after cap+1 calls", async () => {
    const { server, registered } = makeServerCapture();
    const wsId = `ws-read-${Date.now()}-${Math.random()}`;
    registerVaultTools(server, makeBackend(), { workspaceId: wsId });

    const handler = registered.get("garden_read")!;
    expect(handler).toBeDefined();

    // Hit the 120/min read cap
    for (let i = 0; i < 120; i++) {
      const res = await handler({ path: "notes/test.md" });
      expect(res.isError).not.toBe(true);
    }

    // 121st call should be rate-limited
    const res121 = await handler({ path: "notes/test.md" });
    expect(res121.isError).toBe(true);
    expect(res121.content[0].text).toMatch(/Rate limit/i);
  });

  it("workspace buckets are independent — second workspace is not limited", async () => {
    const { server, registered } = makeServerCapture();
    const wsA = `ws-indep-a-${Date.now()}-${Math.random()}`;
    registerVaultTools(server, makeBackend(), { workspaceId: wsA });

    const handler = registered.get("garden_plant")!;

    // Exhaust workspace A's write budget
    for (let i = 0; i < 30; i++) {
      await handler({ path: "notes/test.md", content: "# test" });
    }
    const resA31 = await handler({ path: "notes/test.md", content: "# test" });
    expect(resA31.isError).toBe(true);

    // Workspace B uses a different server/opts — it has a fresh bucket
    const { server: serverB, registered: registeredB } = makeServerCapture();
    const wsB = `ws-indep-b-${Date.now()}-${Math.random()}`;
    registerVaultTools(serverB, makeBackend(), { workspaceId: wsB });

    const handlerB = registeredB.get("garden_plant")!;
    const resB = await handlerB({ path: "notes/test.md", content: "# test" });
    // Workspace B should NOT be rate-limited
    expect(resB.isError).not.toBe(true);
  });

  it("TAPROOT_DISABLE_TOOL_RATE_LIMIT=1 bypasses the limit", async () => {
    vi.stubEnv("TAPROOT_DISABLE_TOOL_RATE_LIMIT", "1");

    const { server, registered } = makeServerCapture();
    const wsId = `ws-bypass-${Date.now()}-${Math.random()}`;
    registerKnowledgeTools(server, makeBackend(), { workspaceId: wsId });

    // taproot_status has a read cap of 120/min — with the gate on, 200 calls should all pass
    const handler = registered.get("taproot_status")!;
    expect(handler).toBeDefined();

    for (let i = 0; i < 200; i++) {
      const res = await handler({});
      expect(res.isError).not.toBe(true);
    }
  });
});
