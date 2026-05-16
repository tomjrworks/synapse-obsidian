import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerKnowledgeTools } from "../../src/tools/knowledge.js";
import type { StorageBackend } from "../../src/utils/storage.js";

// M2: taproot_seed builds its write path from a tool-supplied folder + a
// slugified title. slugify("claude") + ".md" === "claude.md" and folder "."
// resolves onto the protected CLAUDE.md — a prompt-injected agent could
// overwrite persistent AI instructions. The guard must reject it.

type SeedInput = {
  title: string;
  url?: string;
  content?: string;
  folder?: string;
};
type ToolHandler = (input: SeedInput) => Promise<{
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

describe("taproot_seed protected-path guard (M2)", () => {
  let capture: ReturnType<typeof makeServerCapture>;

  beforeEach(() => {
    capture = makeServerCapture();
  });

  it("refuses to write when title+folder resolve onto CLAUDE.md", async () => {
    const writeFile = vi.fn(async () => undefined);
    const backend = makeBackend({ writeFile });
    registerKnowledgeTools(capture.server, backend);
    const seed = capture.registered.get("taproot_seed")!;

    const result = await seed({
      title: "claude",
      content: "injected persistent instructions",
      folder: ".",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/protected|claude\.md/i);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("refuses to write onto index.md", async () => {
    const writeFile = vi.fn(async () => undefined);
    const backend = makeBackend({ writeFile });
    registerKnowledgeTools(capture.server, backend);
    const seed = capture.registered.get("taproot_seed")!;

    const result = await seed({ title: "index", content: "x", folder: "." });

    expect(result.isError).toBe(true);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("writes a normal source note unaffected", async () => {
    const writeFile = vi.fn(async () => undefined);
    const backend = makeBackend({ writeFile });
    registerKnowledgeTools(capture.server, backend);
    const seed = capture.registered.get("taproot_seed")!;

    const result = await seed({
      title: "My Research Note",
      content: "some content",
      folder: "sources",
    });

    expect(result.isError).toBeUndefined();
    expect(writeFile).toHaveBeenCalledOnce();
    expect(writeFile.mock.calls[0][0]).toBe("sources/my-research-note.md");
  });
});
