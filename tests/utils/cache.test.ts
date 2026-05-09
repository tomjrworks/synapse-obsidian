import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getFilingHintCached,
  invalidateClaudeMdCache,
} from "../../src/utils/cache.js";
import type { StorageBackend } from "../../src/utils/storage.js";

const TENANT = "test-tenant";

function makeBackend(
  claudeMdContent: string | null,
  overrides: Partial<StorageBackend> = {},
): StorageBackend {
  const exists = vi.fn(
    async (p: string) => p === "CLAUDE.md" && claudeMdContent !== null,
  );
  const readFile = vi.fn(async (_p: string) => claudeMdContent ?? "");
  return {
    readFile,
    writeFile: vi.fn(async () => undefined),
    listFiles: vi.fn(async () => []),
    exists,
    mkdir: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: 0, modifiedAt: new Date() })),
    recentFiles: vi.fn(async () => []),
    listChanged: vi.fn(async () => ({ files: [], next: null })),
    ...overrides,
  } as StorageBackend;
}

const MANAGED_CLAUDE_MD = [
  "Some prose above.",
  "<!-- TAPROOT-MANAGED:filing START -->",
  "| User says | File in | Naming |",
  "| daily note | daily/ | YYYY-MM-DD-topic.md |",
  "<!-- TAPROOT-MANAGED:filing END -->",
  "Some prose below.",
].join("\n");

const LEGACY_CLAUDE_MD = [
  "projects/ is where project notes live.",
  "daily/ is for journal entries.",
  "decisions/ tracks architectural choices.",
].join("\n");

beforeEach(() => {
  // Clear cache between tests so state doesn't leak
  invalidateClaudeMdCache(TENANT);
});

describe("getFilingHintCached — managed section", () => {
  it("returns hint containing managed section body when markers present", async () => {
    const backend = makeBackend(MANAGED_CLAUDE_MD);
    const hint = await getFilingHintCached(backend, TENANT, "projects/foo.md");
    expect(hint).not.toBeNull();
    expect(hint).toContain("Filing rules (CLAUDE.md managed section):");
    expect(hint).toContain("| User says | File in | Naming |");
    expect(hint).toContain("YYYY-MM-DD-topic.md");
  });

  it("returns the same hint regardless of filePath top-level folder", async () => {
    const backend = makeBackend(MANAGED_CLAUDE_MD);
    const hint1 = await getFilingHintCached(backend, TENANT, "projects/foo.md");
    const hint2 = await getFilingHintCached(backend, TENANT, "inbox/bar.md");
    expect(hint1).toBe(hint2);
  });

  it("falls back to regex when managed section markers are present but empty", async () => {
    const emptySection = [
      "<!-- TAPROOT-MANAGED:filing START -->",
      "<!-- TAPROOT-MANAGED:filing END -->",
      "projects/ contains project notes.",
    ].join("\n");
    const backend = makeBackend(emptySection);
    const hint = await getFilingHintCached(backend, TENANT, "projects/foo.md");
    expect(hint).not.toBeNull();
    expect(hint).toContain("Filing rules for `projects/`:");
    expect(hint).toContain("projects/ contains project notes.");
  });
});

describe("getFilingHintCached — legacy regex fallback", () => {
  it("returns regex-matched hint when no managed section exists", async () => {
    const backend = makeBackend(LEGACY_CLAUDE_MD);
    const hint = await getFilingHintCached(
      backend,
      TENANT,
      "projects/some-note.md",
    );
    expect(hint).not.toBeNull();
    expect(hint).toContain("Filing rules for `projects/`:");
    expect(hint).toContain("projects/ is where project notes live.");
  });

  it("returns null when no CLAUDE.md exists", async () => {
    const backend = makeBackend(null);
    const hint = await getFilingHintCached(backend, TENANT, "projects/foo.md");
    expect(hint).toBeNull();
  });

  it("returns null for a vault-root file (topLevel === filePath)", async () => {
    const backend = makeBackend(LEGACY_CLAUDE_MD);
    const hint = await getFilingHintCached(backend, TENANT, "foo.md");
    expect(hint).toBeNull();
    // Should not have read CLAUDE.md at all
    expect(backend.readFile).not.toHaveBeenCalled();
  });
});

describe("getFilingHintCached — caching", () => {
  it("does not call readFile a second time on repeated calls", async () => {
    const backend = makeBackend(MANAGED_CLAUDE_MD);
    await getFilingHintCached(backend, TENANT, "projects/foo.md");
    await getFilingHintCached(backend, TENANT, "projects/bar.md");
    // readFile called exactly once to load CLAUDE.md
    expect(backend.readFile).toHaveBeenCalledTimes(1);
  });

  it("re-reads CLAUDE.md after invalidateClaudeMdCache", async () => {
    const backend = makeBackend(MANAGED_CLAUDE_MD);
    await getFilingHintCached(backend, TENANT, "projects/foo.md");
    invalidateClaudeMdCache(TENANT);
    await getFilingHintCached(backend, TENANT, "projects/foo.md");
    expect(backend.readFile).toHaveBeenCalledTimes(2);
  });
});
