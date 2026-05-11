import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerIndexTool,
  _clearIndexCache,
} from "../../src/tools/index-tool.js";
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

  it("emits a stub section (not silent drop) when index exceeds 16k budget", async () => {
    // 20 top-level folders × 20 files each ≈ 20k chars — exceeds 16k budget.
    // Sections are always top-level (## folder/), so we need volume to trigger truncation.
    const allFiles = Array.from({ length: 20 }, (_, f) =>
      Array.from(
        { length: 20 },
        (_, i) =>
          `folder-${String(f).padStart(2, "0")}/file-${String(i).padStart(3, "0")}.md`,
      ),
    ).flat();
    const backend = makeBackend({
      exists: vi.fn(async () => false),
      readFile: vi.fn(async () => "# Title\n"),
      listFiles: vi.fn(async () => allFiles),
    });
    _clearIndexCache(backend);

    registerIndexTool(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_index")!;
    const result = await handler();
    const text = result.content[0].text;

    // folder-19 is the last alphabetically — gets stubbed first, header must still appear
    expect(text).toContain("## folder-19/");
    // Stub line with correct file count
    expect(text).toContain(
      "Truncated — 20 files. Call `garden_survey` for details.",
    );
    // Legacy silent-drop footer must NOT appear
    expect(text).not.toContain("<truncated: deepest-");
  });

  it("emits singular 'file' (not 'files') in stub when folder has exactly 1 file", async () => {
    // 19 folders × 20 files + folder-19 with 1 file — total still exceeds 16k
    const fullFolders = Array.from({ length: 19 }, (_, f) =>
      Array.from(
        { length: 20 },
        (_, i) =>
          `folder-${String(f).padStart(2, "0")}/file-${String(i).padStart(3, "0")}.md`,
      ),
    ).flat();
    const singletonFolder = ["folder-19/lonely.md"];
    const backend = makeBackend({
      exists: vi.fn(async () => false),
      readFile: vi.fn(async () => "# Title\n"),
      listFiles: vi.fn(async () => [...fullFolders, ...singletonFolder]),
    });
    _clearIndexCache(backend);

    registerIndexTool(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_index")!;
    const result = await handler();
    const text = result.content[0].text;

    // folder-19 (1 file) is the last alphabetically and gets stubbed — singular form
    expect(text).toMatch(/Truncated — 1 file\. Call/);
    expect(text).not.toMatch(/Truncated — 1 files\./);
  });

  it("stub output is stable across two renders of the same input", async () => {
    const allFiles = Array.from({ length: 20 }, (_, f) =>
      Array.from(
        { length: 20 },
        (_, i) =>
          `folder-${String(f).padStart(2, "0")}/file-${String(i).padStart(3, "0")}.md`,
      ),
    ).flat();

    const backend1 = makeBackend({
      exists: vi.fn(async () => false),
      readFile: vi.fn(async () => "# Title\n"),
      listFiles: vi.fn(async () => [...allFiles]),
    });
    const backend2 = makeBackend({
      exists: vi.fn(async () => false),
      readFile: vi.fn(async () => "# Title\n"),
      listFiles: vi.fn(async () => [...allFiles]),
    });
    _clearIndexCache(backend1);
    _clearIndexCache(backend2);

    registerIndexTool(serverCapture.server, backend1);
    const handler1 = serverCapture.registered.get("garden_index")!;
    const result1 = await handler1();

    const serverCapture2 = makeServerCapture();
    registerIndexTool(serverCapture2.server, backend2);
    const handler2 = serverCapture2.registered.get("garden_index")!;
    const result2 = await handler2();

    expect(result1.content[0].text).toBe(result2.content[0].text);
  });

  describe("write-back format (disk index.md)", () => {
    it("writes a clean human-readable index, not the MCP-tool-response format", async () => {
      // Real-world repro: vault has 30 files in a folder (above per-folder
      // cap of 20) — the disk-format must list ALL of them, no truncation
      // hints, no cardinality dumps, no file paths in entries.
      const files = Array.from(
        { length: 30 },
        (_, i) => `daily/2026-05-${String(i + 1).padStart(2, "0")}-session.md`,
      );
      const writeFile = vi.fn(async () => undefined);
      const backend = makeBackend({
        exists: vi.fn(async (p: string) => p === "index.md"),
        readFile: vi.fn(async (p: string) => {
          if (p === "index.md") return ""; // fresh — write-back proceeds
          // Each note has frontmatter summary
          return `---\ntitle: Daily session\nsummary: Session log for the day\ntags: [daily]\n---\n# Daily\n`;
        }),
        listFiles: vi.fn(async () => files),
        writeFile,
      });
      _clearIndexCache(backend);

      registerIndexTool(serverCapture.server, backend);
      const handler = serverCapture.registered.get("garden_index")!;
      await handler();

      // Write-back fires asynchronously after the tool returns
      await new Promise((r) => setImmediate(r));

      expect(writeFile).toHaveBeenCalled();
      const written = writeFile.mock.calls[0][1] as string;

      // Clean format: wikilink + em-dash + summary. No path, no [cardinality].
      expect(written).toMatch(
        /- \[\[2026-05-01-session\]\] — Session log for the day/,
      );
      // All 30 files present — disk format never truncates per-folder
      expect(written).toMatch(/2026-05-30-session/);
      // NO MCP truncation hints
      expect(written).not.toMatch(/_\(\d+ more in this folder/);
      expect(written).not.toMatch(/call `garden_survey/);
      // NO char-budget stubs
      expect(written).not.toMatch(
        /\*Truncated — \d+ files?\. Call `garden_survey`/,
      );
      // NO file-path before summary
      expect(written).not.toMatch(/`daily\/2026-05-01-session\.md`/);
      // NO cardinality dump
      expect(written).not.toMatch(/\[tags:.*\| summary:/);
      // Wrapped with managed marker
      expect(written).toMatch(/TAPROOT-MANAGED:index: true/);
    });

    it("loads each file's content only once across both renderers", async () => {
      // Regression guard: before the refactor, flush/handler made two
      // listFiles + 2× readFile passes (one per renderer). The refactor
      // shares one loadIndexData call between MCP + disk render.
      const files = ["projects/foo.md", "projects/bar.md"];
      const readFile = vi.fn(async () => "# Note\n");
      const listFiles = vi.fn(async () => files);
      const backend = makeBackend({
        exists: vi.fn(async () => false),
        readFile,
        listFiles,
        writeFile: vi.fn(async () => undefined),
      });
      _clearIndexCache(backend);

      registerIndexTool(serverCapture.server, backend);
      const handler = serverCapture.registered.get("garden_index")!;
      await handler();
      await new Promise((r) => setImmediate(r));

      expect(listFiles).toHaveBeenCalledTimes(1);
      // 2 files × 1 pass = 2 reads (not 4)
      expect(readFile).toHaveBeenCalledTimes(2);
    });
  });
});
