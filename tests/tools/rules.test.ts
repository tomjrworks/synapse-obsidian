import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRulesTool } from "../../src/tools/rules.js";
import type { StorageBackend } from "../../src/utils/storage.js";

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

function makeBackend(overrides: Partial<StorageBackend> = {}): StorageBackend {
  return {
    readFile: vi.fn(async () => ""),
    writeFile: vi.fn(async () => undefined),
    listFiles: vi.fn(async () => []),
    exists: vi.fn(async () => false),
    mkdir: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: 0, modifiedAt: new Date() })),
    recentFiles: vi.fn(async () => []),
    listChanged: vi.fn(async () => ({ files: [], next: null })),
    ...overrides,
  } as StorageBackend;
}

describe("garden_rules", () => {
  let serverCapture: ReturnType<typeof makeServerCapture>;

  beforeEach(() => {
    serverCapture = makeServerCapture();
  });

  it('returns CLAUDE.md content wrapped in <vault-rules source="CLAUDE.md"> when it exists', async () => {
    const claudeMd = "# My Vault\n\nFile rules here.";
    const backend = makeBackend({
      exists: vi.fn(async (p: string) => p === "CLAUDE.md"),
      readFile: vi.fn(async (p: string) => {
        if (p === "CLAUDE.md") return claudeMd;
        throw new Error(`unexpected read: ${p}`);
      }),
    });

    registerRulesTool(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_rules");
    expect(handler).toBeDefined();

    const result = await handler!({});

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain('source="CLAUDE.md"');
    expect(result.content[0].text).toContain(claudeMd);
    expect(result.content[0].text).toMatch(
      /<vault-rules[^>]*>[\s\S]*<\/vault-rules>/,
    );
  });

  it("returns starter rules with a note when CLAUDE.md is missing", async () => {
    const backend = makeBackend({
      exists: vi.fn(async () => false),
    });

    registerRulesTool(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_rules")!;
    const result = await handler({});

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('source="starter"');
    expect(result.content[0].text).toContain("No CLAUDE.md yet");
    expect(result.content[0].text).toContain("Filing Rules (starter");
    expect(backend.readFile).not.toHaveBeenCalled();
  });

  it("surfaces the error message when the backend throws", async () => {
    const backend = makeBackend({
      exists: vi.fn(async () => {
        throw new Error("supabase: permission denied");
      }),
    });

    registerRulesTool(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_rules")!;
    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("garden_rules_failed");
    expect(result.content[0].text).toContain("request_id:");
  });
});
