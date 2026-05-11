import { describe, it, expect, vi } from "vitest";
import {
  parseIgnorePatterns,
  pathMatchesIgnore,
  loadIgnorePatterns,
} from "../../src/utils/taproot-ignore.js";
import type { StorageBackend } from "../../src/utils/storage.js";

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

describe("parseIgnorePatterns", () => {
  it("returns [] when CLAUDE.md is null / empty / no block", () => {
    expect(parseIgnorePatterns(null)).toEqual([]);
    expect(parseIgnorePatterns(undefined)).toEqual([]);
    expect(parseIgnorePatterns("")).toEqual([]);
    expect(
      parseIgnorePatterns("# just a regular CLAUDE.md\n\nno block here"),
    ).toEqual([]);
  });

  it("extracts patterns from the TAPROOT-IGNORE comment block", () => {
    const md = `# CLAUDE.md\n\nsome content\n\n<!-- TAPROOT-IGNORE\nprojects/foo/leads/\nresearch/big-corpus.md\n-->\n`;
    expect(parseIgnorePatterns(md)).toEqual([
      "projects/foo/leads/",
      "research/big-corpus.md",
    ]);
  });

  it("ignores comment lines and inline comments", () => {
    const md = `<!-- TAPROOT-IGNORE\n# this is a header comment\nprojects/foo/   # inline comment\n\nresearch/bar/\n-->`;
    expect(parseIgnorePatterns(md)).toEqual(["projects/foo/", "research/bar/"]);
  });

  it("tolerates whitespace + case-insensitive block marker", () => {
    const md = `<!--  taproot-ignore\n   projects/foo/\n  -->`;
    expect(parseIgnorePatterns(md)).toEqual(["projects/foo/"]);
  });

  it("returns first block only if multiple (edge case — second block ignored)", () => {
    const md = `<!-- TAPROOT-IGNORE\na/\n-->\nsome content\n<!-- TAPROOT-IGNORE\nb/\n-->`;
    expect(parseIgnorePatterns(md)).toEqual(["a/"]);
  });
});

describe("pathMatchesIgnore", () => {
  it("matches directory patterns (trailing slash)", () => {
    const patterns = ["projects/foo/leads/"];
    expect(pathMatchesIgnore("projects/foo/leads/file.md", patterns)).toBe(
      true,
    );
    expect(
      pathMatchesIgnore("projects/foo/leads/sub/nested.md", patterns),
    ).toBe(true);
    expect(
      pathMatchesIgnore("projects/foo/leads-other/file.md", patterns),
    ).toBe(false);
    expect(pathMatchesIgnore("projects/foo/other/file.md", patterns)).toBe(
      false,
    );
  });

  it("matches exact file paths", () => {
    const patterns = ["research/big-corpus.md"];
    expect(pathMatchesIgnore("research/big-corpus.md", patterns)).toBe(true);
    expect(pathMatchesIgnore("research/big-corpus-other.md", patterns)).toBe(
      false,
    );
  });

  it("matches no-trailing-slash directory-style patterns as dir prefix too", () => {
    const patterns = ["projects/foo"];
    expect(pathMatchesIgnore("projects/foo", patterns)).toBe(true);
    expect(pathMatchesIgnore("projects/foo/sub.md", patterns)).toBe(true);
    expect(pathMatchesIgnore("projects/foobar/sub.md", patterns)).toBe(false);
  });

  it("returns false on empty patterns", () => {
    expect(pathMatchesIgnore("anything", [])).toBe(false);
  });

  it("matches if ANY pattern matches", () => {
    const patterns = ["a/", "b/", "c/"];
    expect(pathMatchesIgnore("b/note.md", patterns)).toBe(true);
    expect(pathMatchesIgnore("z/note.md", patterns)).toBe(false);
  });
});

describe("loadIgnorePatterns", () => {
  it("returns [] when CLAUDE.md doesn't exist", async () => {
    const backend = makeBackend({ exists: vi.fn(async () => false) });
    expect(await loadIgnorePatterns(backend)).toEqual([]);
  });

  it("reads + parses the patterns from CLAUDE.md", async () => {
    const md = `# CLAUDE.md\n<!-- TAPROOT-IGNORE\nprojects/foo/leads/\n-->`;
    const backend = makeBackend({
      exists: vi.fn(async () => true),
      readFile: vi.fn(async () => md),
    });
    expect(await loadIgnorePatterns(backend)).toEqual(["projects/foo/leads/"]);
  });

  it("returns [] on backend read failure (never throws)", async () => {
    const backend = makeBackend({
      exists: vi.fn(async () => true),
      readFile: vi.fn(async () => {
        throw new Error("storage unavailable");
      }),
    });
    expect(await loadIgnorePatterns(backend)).toEqual([]);
  });
});
