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
      readFile: vi.fn(async (p: string) => {
        if (p === "index.md") return staleIndex;
        return ""; // vault files return empty content
      }),
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
    // readFile is called per-file for cardinality/summary extraction
    expect(backend.readFile).not.toHaveBeenCalledWith("index.md");
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

    // listFiles called once — cache prevents subsequent calls
    expect(backend.listFiles).toHaveBeenCalledTimes(1);
    // exists called for index.md check on first call; background write-back may
    // call it again but the second + third handler calls hit the in-memory cache
    expect(backend.listFiles).toHaveBeenCalledTimes(1);
  });

  it("renders per-entry lines with cardinality and summary when content is available", async () => {
    const fileContent = [
      "---",
      "tags: [ai, research]",
      "status: active",
      "summary: A test note about AI",
      "---",
      "# My AI Note",
      "Some body text here.",
    ].join("\n");

    const backend = makeBackend({
      exists: vi.fn(async () => false),
      readFile: vi.fn(async () => fileContent),
      listFiles: vi.fn(async () => ["research/ai-note.md"]),
    });

    registerIndexTool(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_index")!;
    const result = await handler();

    const text = result.content[0].text;
    expect(text).toContain("[[ai-note]]");
    // Cardinality line rendered
    expect(text).toContain("[tags: ai, research | status: active");
    // Summary from frontmatter
    expect(text).toContain("A test note about AI");
  });

  it("falls back to H1 then truncated body when no frontmatter summary", async () => {
    const noSummaryContent = "# Great Title\n\nSome body content here.";
    const backend = makeBackend({
      exists: vi.fn(async () => false),
      readFile: vi.fn(async () => noSummaryContent),
      listFiles: vi.fn(async () => ["notes/great-note.md"]),
    });

    registerIndexTool(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_index")!;
    const result = await handler();

    expect(result.content[0].text).toContain("Great Title");
  });
});
