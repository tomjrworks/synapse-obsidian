import { describe, it, expect, vi, afterEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerVaultTools, parseForageHints } from "../../src/tools/vault.js";
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
  const backend = {
    readFile: vi.fn(async (p: string) => {
      if (p in files) return files[p];
      throw new Error(`not found: ${p}`);
    }),
    writeFile: vi.fn(async () => undefined),
    listFiles: vi.fn(async () =>
      Object.keys(files).filter((f) => f !== "index.md"),
    ),
    exists: vi.fn(async (p: string) => p in files),
    mkdir: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: 0, modifiedAt: new Date() })),
    recentFiles: vi.fn(async () => []),
    listChanged: vi.fn(async () => ({ files: [], next: null })),
    ...overrides,
  } as StorageBackend;
  return backend;
}

// ─── Unit tests: parseForageHints ────────────────────────────────────────────

describe("parseForageHints", () => {
  const INDEX = [
    "- [[projects/glug/glug]] — glug water tracker app",
    "- [[notes/taproot]] — taproot memory layer overview",
    "- [[inbox/random]] — unrelated stuff",
  ].join("\n");

  it("T1: returns path when wikilink path contains query", () => {
    const hints = parseForageHints(INDEX, "glug");
    expect(hints).toContain("projects/glug/glug.md");
  });

  it("T2: returns path when summary contains query", () => {
    const hints = parseForageHints(INDEX, "memory layer");
    expect(hints).toContain("notes/taproot.md");
  });

  it("T3: returns empty array when nothing matches", () => {
    const hints = parseForageHints(INDEX, "zzznomatch");
    expect(hints).toEqual([]);
  });

  it("T4: parses both em dash and double-hyphen separators", () => {
    const mixed = [
      "- [[projects/alpha]] — alpha entry with keyword",
      "- [[projects/beta]] -- beta entry with keyword",
    ].join("\n");
    const hints = parseForageHints(mixed, "keyword");
    expect(hints).toContain("projects/alpha.md");
    expect(hints).toContain("projects/beta.md");
  });

  it("T5: match is case-insensitive", () => {
    const hints = parseForageHints(INDEX, "Taproot");
    expect(hints).toContain("notes/taproot.md");
  });
});

// ─── Integration tests: garden_forage handler ────────────────────────────────

describe("garden_forage handler", () => {
  it("T6: 2 files, only 1 matches — returns correct file", async () => {
    const backend = makeBackend({
      "notes/match.md": "This note contains the keyword taproot",
      "notes/nomatch.md": "This note has nothing relevant",
    });
    const { server, registered } = makeServerCapture();
    registerVaultTools(server, backend);
    const handler = registered.get("garden_forage")!;

    const result = await handler({ query: "taproot" });
    const text = result.content[0].text;
    expect(text).toContain("notes/match.md");
    expect(text).not.toContain("notes/nomatch.md");
  });

  it("T7: 3 files all match, maxResults=2 — only 2 results returned", async () => {
    const backend = makeBackend({
      "a.md": "contains glug",
      "b.md": "also contains glug",
      "c.md": "glug again",
    });
    const { server, registered } = makeServerCapture();
    registerVaultTools(server, backend);
    const handler = registered.get("garden_forage")!;

    const result = await handler({ query: "glug", maxResults: 2 });
    const text = result.content[0].text;
    expect(text).toContain("2 files match");
  });

  it("T8: index hint for file listed last — that file appears first in results", async () => {
    const backend = makeBackend(
      {
        "index.md":
          "- [[projects/target]] — taproot target note\n- [[other]] — other stuff",
        "other.md": "taproot mention in other",
        "projects/target.md": "taproot is described here",
      },
      {
        // listFiles returns non-priority file first
        listFiles: vi.fn(async () => ["other.md", "projects/target.md"]),
      },
    );
    const { server, registered } = makeServerCapture();
    registerVaultTools(server, backend);
    const handler = registered.get("garden_forage")!;

    const result = await handler({ query: "taproot" });
    const text = result.content[0].text;
    // projects/target.md should appear before other.md
    expect(text.indexOf("projects/target.md")).toBeLessThan(
      text.indexOf("other.md"),
    );
  });

  it("T9: zero matches — returns 'No results' message", async () => {
    const backend = makeBackend({
      "notes/empty.md": "nothing here",
    });
    const { server, registered } = makeServerCapture();
    registerVaultTools(server, backend);
    const handler = registered.get("garden_forage")!;

    const result = await handler({ query: "zzznomatch" });
    expect(result.content[0].text).toContain('No results for "zzznomatch"');
  });

  it("T10: hanging listFiles + zero timeout — output contains 'budget exhausted'", async () => {
    process.env.FORAGE_TIMEOUT_MS = "50";
    const hangingBackend = makeBackend(
      {},
      {
        listFiles: vi.fn(() => new Promise<string[]>(() => {})),
        exists: vi.fn(async () => false),
      },
    );
    const { server, registered } = makeServerCapture();
    registerVaultTools(server, hangingBackend);
    const handler = registered.get("garden_forage")!;

    const result = await handler({ query: "anything" });
    expect(result.content[0].text).toContain("budget exhausted");

    delete process.env.FORAGE_TIMEOUT_MS;
  }, 5000);
});

// ─── No background churn: the in-loop budget STOPS the scan ───────────────────
describe("garden_forage — bounded scan leaves no orphaned background work", () => {
  afterEach(() => {
    delete process.env.FORAGE_TIMEOUT_MS;
  });

  it("EVAL#2: after the budget fires, readFile count is frozen (no churn)", async () => {
    process.env.FORAGE_TIMEOUT_MS = "60";
    const files: Record<string, string> = {};
    for (let i = 0; i < 200; i++) {
      files[`notes/n${i}.md`] = "no relevant content in this note";
    }
    const backend = makeBackend(files, {
      readFile: vi.fn(async (p: string) => {
        await new Promise((r) => setTimeout(r, 20)); // slow reads
        if (p in files) return files[p];
        throw new Error(`not found: ${p}`);
      }),
    });
    const { server, registered } = makeServerCapture();
    registerVaultTools(server, backend);
    const handler = registered.get("garden_forage")!;

    const res = await handler({ query: "zzznomatchqqq" });
    expect(res.content[0].text).toContain("budget exhausted");

    const readFile = backend.readFile as ReturnType<typeof vi.fn>;
    const atResolve = readFile.mock.calls.length;
    await new Promise((r) => setTimeout(r, 300));
    const later = readFile.mock.calls.length;

    // Pre-fix: withTimeout (Promise.race) returns but scanPath keeps reading all
    // 200 files in the background → later > atResolve. Post-fix: the in-loop
    // budget breaks the loop, so the work actually stops.
    expect(later).toBe(atResolve);
  }, 5000);
});
