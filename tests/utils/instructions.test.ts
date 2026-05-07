import { describe, it, expect, vi } from "vitest";
import { assembleInstructions } from "../../src/utils/instructions.js";
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

describe("assembleInstructions", () => {
  it("stays within the 1500-byte budget even with maximal workspace context", async () => {
    const backend = makeBackend({
      recentFiles: vi.fn(async () =>
        Array.from(
          { length: 50 },
          (_, i) => `projects/very-long-folder-name-${i}/file-${i}.md`,
        ),
      ),
    });

    const out = await assembleInstructions(backend);
    const bytes = new TextEncoder().encode(out).length;

    expect(bytes).toBeLessThanOrEqual(1500);
  });

  it("always includes the preamble + tool pointers even when workspace context fails", async () => {
    const backend = makeBackend({
      recentFiles: vi.fn(async () => {
        throw new Error("supabase unreachable");
      }),
    });

    const out = await assembleInstructions(backend);

    expect(out).toContain("Taproot vault");
    expect(out).toContain("garden_rules");
    expect(out).toContain("garden_index");
    expect(out).toContain("garden_plant");
    expect(out).toContain("30s");
  });

  it("includes a workspace-context line when recentFiles returns data", async () => {
    const backend = makeBackend({
      recentFiles: vi.fn(async () => [
        "projects/taproot/note.md",
        "projects/taproot/decision.md",
        "projects/taproot/log.md",
        "daily/2026-05-07-foo.md",
      ]),
    });

    const out = await assembleInstructions(backend);

    expect(out).toContain("most active folder is `projects/`");
    expect(out).toContain("activity in the last");
  });

  it("includes curation guidance — proactive CLAUDE.md rule proposal pattern", async () => {
    const out = await assembleInstructions(makeBackend());
    expect(out).toContain("Curate as you go");
    expect(out).toContain("3+ saves");
    expect(out).toContain("CLAUDE.md filing rule");
    expect(out).toContain("acknowledgeRoot: true");
    expect(out).toContain("Never propose more than once per session");
  });

  it("degrades gracefully (no context line) when recentFiles is empty or throws", async () => {
    const empty = await assembleInstructions(makeBackend({}));
    expect(empty).not.toContain("most active folder");

    const errored = await assembleInstructions(
      makeBackend({
        recentFiles: vi.fn(async () => {
          throw new Error("boom");
        }),
      }),
    );
    expect(errored).not.toContain("most active folder");
    expect(errored).toContain("garden_rules");
  });
});
