import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerKnowledgeTools } from "../../src/tools/knowledge.js";
import {
  extractKeywords,
  parseIndexCandidates,
  isTemporalQuestion,
} from "../../src/tools/knowledge.js";
import type { StorageBackend } from "../../src/utils/storage.js";

type ToolHandler = (input: any) => Promise<{
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

function makeBackend(
  files: Record<string, string>,
  overrides: Partial<StorageBackend> = {},
): StorageBackend {
  const writes: Record<string, string> = {};
  return {
    readFile: vi.fn(async (p: string) => {
      if (p in writes) return writes[p];
      if (p in files) return files[p];
      throw new Error(`not found: ${p}`);
    }),
    writeFile: vi.fn(async (p: string, c: string) => {
      writes[p] = c;
    }),
    listFiles: vi.fn(async () => Object.keys(files)),
    exists: vi.fn(async (p: string) => p in files),
    mkdir: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: 0, modifiedAt: new Date() })),
    recentFiles: vi.fn(async () => []),
    listChanged: vi.fn(async () => ({ files: [], next: null })),
    ...overrides,
  } as StorageBackend;
}

describe("taproot_harvest", () => {
  let serverCapture: ReturnType<typeof makeServerCapture>;

  beforeEach(() => {
    serverCapture = makeServerCapture();
  });

  // Test 1: Empty vault — no crash, setup tip in output
  it("handles empty vault without crashing and includes setup tip", async () => {
    const backend = makeBackend({});
    registerKnowledgeTools(serverCapture.server, backend);
    const handler = serverCapture.registered.get("taproot_harvest")!;

    const result = await handler({ question: "what is glug", save: false });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("taproot_plant");
  });

  // Test 2: Index-pass hit — reads only matching files, not all 50
  it("uses index-first path and reads only matching candidates", async () => {
    const files: Record<string, string> = {
      "index.md": [
        "# Vault Index",
        "",
        "- [[glug-notes]] — Glug project notes and status",
        "- [[glug-design]] — Glug UI design decisions",
        "- [[glug-dev]] — Glug development log",
        "- [[unrelated-a]] — unrelated alpha topic",
        "- [[unrelated-b]] — unrelated beta topic",
      ].join("\n"),
      "glug-notes.md": "# Glug Notes\nglug is a water app",
      "glug-design.md": "# Glug Design\nUI decisions for glug",
      "glug-dev.md": "# Glug Dev\ndevelopment log for glug",
      "unrelated-a.md": "# Alpha\nalpha content",
      "unrelated-b.md": "# Beta\nbeta content",
    };
    // Pad with 45 more files so total = 50
    for (let i = 0; i < 45; i++) {
      files[`extra-${i}.md`] = `# Extra ${i}\ncontent ${i}`;
    }

    const backend = makeBackend(files);
    registerKnowledgeTools(serverCapture.server, backend);
    const handler = serverCapture.registered.get("taproot_harvest")!;

    await handler({ question: "glug status", save: false });

    const readFile = backend.readFile as ReturnType<typeof vi.fn>;
    const readCalls = readFile.mock.calls.map((c: any[]) => c[0] as string);
    // Should read index.md + the 3 glug files + maybe config, not all 50
    const noteReads = readCalls.filter(
      (p) => p !== "index.md" && !p.includes("config"),
    );
    // Only 3 glug files matched — should NOT have read any extra-* files
    expect(noteReads.some((p) => p.startsWith("extra-"))).toBe(false);
    expect(noteReads.filter((p) => p.startsWith("glug")).length).toBe(3);
  });

  // Test 3: Punctuation strip — query artifacts don't survive as keywords
  it("strips punctuation from keywords", () => {
    const kw = extractKeywords("What is Glug? Status, design, development?");
    expect(kw).not.toContain("glug?");
    expect(kw).not.toContain("status,");
    expect(kw).toContain("glug");
    expect(kw).toContain("status");
    expect(kw).toContain("design");
    expect(kw).toContain("development");
  });

  // Test 4: Stop-word filter — common English words are removed
  it("removes stop words and leaves only substantive keywords", () => {
    const kw = extractKeywords("what does my brain say about glug");
    expect(kw).not.toContain("what");
    expect(kw).not.toContain("does");
    expect(kw).not.toContain("about");
    expect(kw).toContain("glug");
  });

  // Test 5: Body fallback — no/empty index triggers searchVault path
  it("falls back to body search when index is missing", async () => {
    const backend = makeBackend({
      "notes/glug.md": "# Glug\nglug is a water tracking app",
    });
    registerKnowledgeTools(serverCapture.server, backend);
    const handler = serverCapture.registered.get("taproot_harvest")!;

    const result = await handler({ question: "glug status", save: false });
    const text = result.content[0].text;
    // Body search found the file
    expect(text).toContain("Relevant Pages");
    expect(text).toContain("notes/glug.md");
  });

  // Test 6: Soft timeout — partial results sentinel appears when budget exceeded
  it("returns partial-results sentinel when budget is exhausted", async () => {
    // 50ms budget via env var — fast enough for a unit test
    process.env.HARVEST_TIMEOUT_MS = "50";

    // Backend with no index; listFiles returns one file that hangs on read
    const hangBackend = makeBackend(
      {},
      {
        exists: vi.fn(async () => false),
        listFiles: vi.fn(async () => ["slow-file.md"]),
        readFile: vi.fn(() => new Promise<string>(() => {})),
      },
    );

    const freshCapture = makeServerCapture();
    registerKnowledgeTools(freshCapture.server, hangBackend);
    const handler = freshCapture.registered.get("taproot_harvest")!;

    const result = await handler({ question: "glug", save: false });
    expect(result.content[0].text).toContain("partial results");

    delete process.env.HARVEST_TIMEOUT_MS;
  }, 5000);
});

// Pure unit tests for helper functions
describe("extractKeywords", () => {
  it("returns at most 5 keywords", () => {
    const kw = extractKeywords(
      "glug water tracking hydration health fitness goals",
    );
    expect(kw.length).toBeLessThanOrEqual(5);
  });

  it("filters words of 3 chars or fewer", () => {
    const kw = extractKeywords("the big cat and a dog");
    expect(kw).not.toContain("the");
    expect(kw).not.toContain("and");
    expect(kw.every((w) => w.length > 3)).toBe(true);
  });
});

describe("parseIndexCandidates", () => {
  it("parses wikilink entries and scores by keyword overlap", () => {
    const index = [
      "- [[glug-notes]] — Glug project notes",
      "- [[other-project]] — Something unrelated",
    ].join("\n");

    const candidates = parseIndexCandidates(index, ["glug"]);
    expect(candidates[0].path).toBe("glug-notes.md");
    expect(candidates[0].score).toBe(1);
    expect(candidates[1].score).toBe(0);
  });

  it("handles em-dash (—) and double-hyphen (--) separators", () => {
    const index = [
      "- [[note-a]] — em dash entry",
      "- [[note-b]] -- double hyphen entry",
    ].join("\n");

    const candidates = parseIndexCandidates(index, ["entry"]);
    expect(candidates.length).toBe(2);
  });

  it("returns empty array for empty index", () => {
    expect(parseIndexCandidates("", ["glug"])).toEqual([]);
  });
});

describe("isTemporalQuestion", () => {
  it("returns true for temporal signal phrases", () => {
    expect(isTemporalQuestion("Brief me on what I've been working on")).toBe(
      true,
    );
    expect(isTemporalQuestion("What have I been doing lately?")).toBe(true);
    expect(isTemporalQuestion("Catch me up on recent work")).toBe(true);
    expect(isTemporalQuestion("What did I work on last week?")).toBe(true);
  });

  it("returns false for non-temporal questions", () => {
    expect(isTemporalQuestion("Where are we in the Glug project?")).toBe(false);
    expect(isTemporalQuestion("What is taproot_harvest?")).toBe(false);
    expect(isTemporalQuestion("Show me the Taproot pricing decision")).toBe(
      false,
    );
  });
});

describe("taproot_harvest temporal augmentation", () => {
  let serverCapture: ReturnType<typeof makeServerCapture>;

  beforeEach(() => {
    serverCapture = makeServerCapture();
  });

  // Test: temporal question with daily/ files present — recent files appear in output
  it("includes recent daily files for temporal questions", async () => {
    const backend = makeBackend(
      {
        "index.md": "# Vault Index\n\n- [[glug-notes]] — Glug project notes",
        "glug-notes.md": "# Glug Notes\nglug is a water app",
        "daily/2026-05/2026-05-13-taproot-session.md":
          "# Session\nWorked on harvest fix today",
      },
      {
        recentFiles: vi.fn(async () => [
          "daily/2026-05/2026-05-13-taproot-session.md",
        ]),
      },
    );

    registerKnowledgeTools(serverCapture.server, backend);
    const handler = serverCapture.registered.get("taproot_harvest")!;

    const result = await handler({
      question: "Brief me on what I've been working on",
      save: false,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("daily/2026-05/2026-05-13-taproot-session.md");
  });

  // Test: non-temporal question — recentFiles is NOT called
  it("does not call recentFiles for non-temporal questions", async () => {
    const recentFiles = vi.fn(async () => []);
    const backend = makeBackend(
      {
        "index.md":
          "# Vault Index\n\n- [[glug-notes]] — Glug project notes and status",
        "glug-notes.md": "# Glug Notes\nglug is a water app",
      },
      { recentFiles },
    );

    registerKnowledgeTools(serverCapture.server, backend);
    const handler = serverCapture.registered.get("taproot_harvest")!;

    await handler({
      question: "Where are we in the Glug project?",
      save: false,
    });
    expect(recentFiles).not.toHaveBeenCalled();
  });

  // Test: temporal question, no daily/ files — graceful fallback, no crash
  it("handles empty recent files list gracefully for temporal questions", async () => {
    const backend = makeBackend(
      {
        "index.md": "# Vault Index\n\n- [[glug-notes]] — Glug project notes",
        "glug-notes.md": "# Glug Notes\nglug is a water app",
      },
      {
        recentFiles: vi.fn(async () => []),
      },
    );

    registerKnowledgeTools(serverCapture.server, backend);
    const handler = serverCapture.registered.get("taproot_harvest")!;

    const result = await handler({
      question: "What have I been working on lately?",
      save: false,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBeTruthy();
  });
});
