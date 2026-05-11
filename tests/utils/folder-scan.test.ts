import { describe, it, expect } from "vitest";
import { scanFolders, _internal } from "../../src/utils/folder-scan.js";
import type { StorageBackend } from "../../src/utils/storage.js";

function makeBackend(
  files: Record<string, { content: string; mtime: number }>,
) {
  return {
    readFile: async (p: string) => {
      const f = files[p];
      if (!f) throw new Error(`not found: ${p}`);
      return f.content;
    },
    writeFile: async () => undefined,
    listFiles: async () => Object.keys(files),
    exists: async (p: string) => p in files,
    mkdir: async () => undefined,
    delete: async () => undefined,
    move: async () => undefined,
    stat: async (p: string) => ({
      size: files[p]?.content.length ?? 0,
      modifiedAt: new Date(files[p]?.mtime ?? 0),
    }),
    recentFiles: async () => [],
    listChanged: async () => ({ files: [], next: null, pendingCount: 0 }),
    getCursorHead: async () => null,
    getPendingCount: async () => 0,
  } as unknown as StorageBackend;
}

describe("scanFolders", () => {
  it("uses frontmatter summary when present", async () => {
    const backend = makeBackend({
      "projects/p.md": {
        content: '---\ntitle: "P"\nsummary: "active work here"\n---\n\n# P\n',
        mtime: 1000,
      },
    });
    const out = await scanFolders(backend);
    expect(out).toEqual([{ name: "projects", summary: "active work here" }]);
  });

  it("falls back to first H1 when no summary frontmatter", async () => {
    const backend = makeBackend({
      "daily/2026-05-11.md": {
        content: "# Today's session log\n\nbody",
        mtime: 1000,
      },
    });
    const out = await scanFolders(backend);
    expect(out).toEqual([{ name: "daily", summary: "Today's session log" }]);
  });

  it("falls back to first content line when no H1", async () => {
    const backend = makeBackend({
      "notes/n.md": {
        content: "Just a one-line note about something\n",
        mtime: 1000,
      },
    });
    const out = await scanFolders(backend);
    expect(out[0].summary).toBe("Just a one-line note about something");
  });

  it("falls back to folder name when nothing matches", async () => {
    const backend = makeBackend({
      "empty/x.md": { content: "", mtime: 1000 },
    });
    const out = await scanFolders(backend);
    expect(out).toEqual([{ name: "empty", summary: "empty/" }]);
  });

  it("excludes hidden folders", async () => {
    const backend = makeBackend({
      ".obsidian/config.md": { content: "# x", mtime: 1 },
      ".git/HEAD.md": { content: "# x", mtime: 1 },
      "projects/p.md": { content: "# Real", mtime: 1 },
    });
    const out = await scanFolders(backend);
    expect(out.map((f) => f.name)).toEqual(["projects"]);
  });

  it("returns folders alphabetically sorted", async () => {
    const backend = makeBackend({
      "zebra/a.md": { content: "# z", mtime: 1 },
      "alpha/a.md": { content: "# a", mtime: 1 },
      "mango/a.md": { content: "# m", mtime: 1 },
    });
    const out = await scanFolders(backend);
    expect(out.map((f) => f.name)).toEqual(["alpha", "mango", "zebra"]);
  });

  it("picks most-recently-modified note for summary derivation", async () => {
    const backend = makeBackend({
      "notes/old.md": {
        content: '---\nsummary: "old summary"\n---\n',
        mtime: 100,
      },
      "notes/new.md": {
        content: '---\nsummary: "new summary"\n---\n',
        mtime: 999,
      },
    });
    const out = await scanFolders(backend);
    expect(out[0].summary).toBe("new summary");
  });

  it("truncates long first-line summaries at 100 chars", () => {
    const long = "x".repeat(200);
    const summary = _internal.deriveSummary("notes", long);
    expect(summary.length).toBeLessThanOrEqual(100);
    expect(summary).toMatch(/\.\.\.$/);
  });
});
