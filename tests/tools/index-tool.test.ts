import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerIndexTool } from "../../src/tools/index-tool.js";
import type { StorageBackend } from "../../src/utils/storage.js";

type ToolHandler = () => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

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

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("garden_index", () => {
  let serverCapture: ReturnType<typeof makeServerCapture>;

  beforeEach(() => {
    serverCapture = makeServerCapture();
  });

  it("returns existing index.md verbatim when frontmatter date_modified is fresh", async () => {
    const indexBody = `---\ndate_modified: ${isoDaysAgo(2)}\n---\n\n# My Vault Index\n\nHand-curated content.`;
    const backend = makeBackend({
      exists: vi.fn(async (p: string) => p === "index.md"),
      readFile: vi.fn(async (p: string) => {
        if (p === "index.md") return indexBody;
        throw new Error(`unexpected read: ${p}`);
      }),
      listFiles: vi.fn(async () => ["should-not-be-called.md"]),
    });

    registerIndexTool(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_index")!;
    const result = await handler();

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('source="index.md"');
    expect(result.content[0].text).toContain("Hand-curated content");
    expect(backend.listFiles).not.toHaveBeenCalled();
  });

  it("regenerates from listFiles when index.md is stale (>7 days)", async () => {
    const staleIndex = `---\ndate_modified: ${isoDaysAgo(30)}\n---\n\n# Stale Index`;
    const backend = makeBackend({
      exists: vi.fn(async (p: string) => p === "index.md"),
      readFile: vi.fn(async () => staleIndex),
      listFiles: vi.fn(async () => [
        "daily/2026-05-07-foo.md",
        "decisions/2026-05-06-bar.md",
        "projects/taproot/taproot.md",
      ]),
    });

    registerIndexTool(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_index")!;
    const result = await handler();

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('source="synthesized"');
    expect(result.content[0].text).not.toContain("Stale Index");
    expect(result.content[0].text).toContain("## daily/");
    expect(result.content[0].text).toContain("## decisions/");
    expect(result.content[0].text).toContain("## projects/");
    expect(result.content[0].text).toContain("[[2026-05-07-foo]]");
    expect(backend.listFiles).toHaveBeenCalled();
  });

  it("synthesizes a fresh index when no index.md exists", async () => {
    const backend = makeBackend({
      exists: vi.fn(async () => false),
      listFiles: vi.fn(async () => [
        "research/cold-email/foo.md",
        "research/tools/bar.md",
        "ideas/baz.md",
      ]),
    });

    registerIndexTool(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_index")!;
    const result = await handler();

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('source="synthesized"');
    expect(result.content[0].text).toContain("## ideas/");
    expect(result.content[0].text).toContain("## research/");
    expect(backend.readFile).not.toHaveBeenCalled();
  });

  it("includes the truncation note when listFiles returns the cap (1000)", async () => {
    const manyFiles = Array.from(
      { length: 1000 },
      (_, i) => `notes/file-${String(i).padStart(4, "0")}.md`,
    );
    const backend = makeBackend({
      exists: vi.fn(async () => false),
      listFiles: vi.fn(async () => manyFiles),
    });

    registerIndexTool(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_index")!;
    const result = await handler();

    expect(result.content[0].text).toContain("Showing first 1000 files");
    // Per-folder cap: 1000 files in one folder, only first 20 listed + a "more" hint
    expect(result.content[0].text).toContain("980 more in this folder");
  });

  it("caches the result across calls within the TTL window", async () => {
    const backend = makeBackend({
      exists: vi.fn(async () => false),
      listFiles: vi.fn(async () => ["a.md", "b.md"]),
    });

    registerIndexTool(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_index")!;

    await handler();
    await handler();
    await handler();

    expect(backend.listFiles).toHaveBeenCalledTimes(1);
    expect(backend.exists).toHaveBeenCalledTimes(1);
  });
});
