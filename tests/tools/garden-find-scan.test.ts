import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerVaultTools } from "../../src/tools/vault.js";
import type { StorageBackend } from "../../src/utils/storage.js";

// ─────────────────────────────────────────────────────────────────────────
// Layer-1 EVALS at the garden_find tool boundary. garden_find is a
// title/filename finder; on a no-filename-match query it falls back to a
// full-text body scan. Pre-fix that fallback (searchVault) read + decrypted
// the ENTIRE vault serially — the confirmed minutes-long prod hang. The fix
// routes the fallback through the bounded scanVaultBodies.
//
// The filename-match phase reads ZERO files (it matches basenames from
// listFiles), so on a no-match query the backend.readFile count equals the
// body-scan's reads — making the cap assertion exact.
// ─────────────────────────────────────────────────────────────────────────

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
  return {
    readFile: vi.fn(async (p: string) => {
      if (p in files) return files[p];
      throw new Error(`not found: ${p}`);
    }),
    writeFile: vi.fn(async () => undefined),
    // index.md is excluded from the body-file listing (it's a priority source,
    // not a scan target) — mirrors forage.test.ts.
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
}

const readCount = (b: StorageBackend) =>
  (b.readFile as ReturnType<typeof vi.fn>).mock.calls.length;

function bigVault(n: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    files[`notes/note-${i}.md`] = `body content ${i} with nothing special`;
  }
  return files;
}

describe("garden_find — bounded body fallback", () => {
  beforeEach(() => {
    delete process.env.SCAN_FILE_CAP; // default => cap 300
  });
  afterEach(() => {
    delete process.env.SCAN_FILE_CAP;
  });

  it("EVAL#1 (killer): topical no-match query reads <= SCAN_FILE_CAP, not the whole vault", async () => {
    const backend = makeBackend(bigVault(1000));
    const { server, registered } = makeServerCapture();
    registerVaultTools(server, backend);
    const handler = registered.get("garden_find")!;

    const res = await handler({ query: "zzztopicqqqnomatch" });
    expect(res.isError).toBeFalsy();
    // Pre-fix this is 1000 (full serial scan → the hang). Post-fix <= 300.
    expect(readCount(backend)).toBeLessThanOrEqual(300);
  });

  it("EVAL#8 (kill-switch): SCAN_FILE_CAP=0 restores legacy unbounded scan", async () => {
    process.env.SCAN_FILE_CAP = "0";
    const backend = makeBackend(bigVault(1000));
    const { server, registered } = makeServerCapture();
    registerVaultTools(server, backend);
    const handler = registered.get("garden_find")!;

    await handler({ query: "zzztopicqqqnomatch" });
    expect(readCount(backend)).toBe(1000);
  });

  it("EVAL#4 (priority): an index.md-listed body match beyond the cap is still returned", async () => {
    process.env.SCAN_FILE_CAP = "5";
    const files: Record<string, string> = {};
    files["index.md"] = "- [[notes/target]] — specialterm deep dive note";
    for (let i = 0; i < 50; i++) files[`notes/decoy-${i}.md`] = "nothing here";
    files["notes/target.md"] = "this note covers the specialterm topic"; // listed last

    const backend = makeBackend(files);
    const { server, registered } = makeServerCapture();
    registerVaultTools(server, backend);
    const handler = registered.get("garden_find")!;

    // "specialterm" matches no basename → fallback fires; cap=5 < 51 files, so
    // without priority ordering the target (51st) would be missed.
    const res = await handler({ query: "specialterm" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("notes/target.md");
  });
});
