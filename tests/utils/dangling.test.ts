import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../../src/utils/storage.js";
import { extractOutlinks, linkKey } from "../../src/utils/outlinks.js";
import { danglingTargets } from "../../src/utils/dangling.js";
import { registerKnowledgeTools } from "../../src/tools/knowledge.js";

// ─────────────────────────────────────────────────────────────────────────
// Pass 5 — wikilink dangling-set + A1 resolver unification (decision
// 2026-06-06-pass-5-direction, fork 2). RED-eval-first: `danglingTargets` is a
// stub returning [] (positive-detection D1/D5/D7 fail), and `taproot_prune`
// still uses its divergent ad-hoc regex (knowledge.ts:1171), so the A1 evals
// fail on current code (fenced / inline / #heading links false-flagged broken).
//
// THE precision contract: dangling detection resolves targets the SAME way the
// write path does (outlinks.ts `outlinkKeys`/`linkKey`) — code-fenced and
// inline-code wikilinks are not edges, `#heading` + `|alias` are stripped, and a
// subfolder basename collision resolves (never false "broken").
// ─────────────────────────────────────────────────────────────────────────

/** Existing-page key set: every page basename run through the canonical resolver
 * (matches how the page-existence set is derived elsewhere). */
const pageKeys = (paths: string[]): Set<string> =>
  new Set(paths.map((p) => linkKey(p)));

/** Mirror the persisted `extracted_outlinks` column: each file's stored value IS
 * `extractOutlinks(content)` (what the write hook writes). */
const storedOutlinks = (
  files: Record<string, string>,
): Record<string, string[]> =>
  Object.fromEntries(
    Object.entries(files).map(([p, c]) => [p, extractOutlinks(c)]),
  );

describe("danglingTargets — diff of outbound links vs existing pages", () => {
  it("D1 — a link to a non-existent page is dangling, with its source", () => {
    const existing = pageKeys(["notes/alpha.md"]);
    const byFile = storedOutlinks({
      "notes/alpha.md": "Alpha points at [[ghost]] which does not exist.",
    });
    expect(danglingTargets(existing, byFile)).toEqual([
      { key: "ghost", sources: ["notes/alpha.md"] },
    ]);
  });

  it("D2 — |alias and #heading resolve to the real page (NOT dangling)", () => {
    const existing = pageKeys(["notes/target.md"]);
    const byFile = storedOutlinks({
      "notes/src.md": "See [[target|Display Name]] and [[target#Section]].",
    });
    // Both forms collapse to `target`, which exists → no dangling targets.
    expect(danglingTargets(existing, byFile)).toEqual([]);
  });

  it("D3 — code-fenced / inline-code wikilinks are not edges (C1 carry-through)", () => {
    const existing = pageKeys(["notes/live.md"]);
    const byFile = storedOutlinks({
      "notes/src.md": [
        "Real [[live]] link.",
        "```",
        "[[fenced-ghost]] inside a fence is not an edge",
        "```",
        "Inline `[[inline-ghost]]` is not an edge either.",
      ].join("\n"),
    });
    // Only [[live]] survives extraction, and it exists → nothing dangling.
    expect(danglingTargets(existing, byFile)).toEqual([]);
  });

  it("D4 — a subfolder basename collision resolves (never false-flagged)", () => {
    // Existing page lives in a subfolder; the link uses the bare basename.
    const existing = pageKeys(["projects/taproot/note.md"]);
    const byFile = storedOutlinks({ "notes/src.md": "Link to [[note]]." });
    expect(danglingTargets(existing, byFile)).toEqual([]);
  });

  it("D5 — one entry per dangling key, sources deduped + sorted", () => {
    const existing = pageKeys(["notes/alpha.md"]);
    const byFile = storedOutlinks({
      "notes/zeta.md": "needs [[ghost]]",
      "notes/alpha.md": "also needs [[ghost]] twice [[ghost]]",
    });
    expect(danglingTargets(existing, byFile)).toEqual([
      { key: "ghost", sources: ["notes/alpha.md", "notes/zeta.md"] },
    ]);
  });

  it("D6 — a file with no outbound links yields nothing", () => {
    const existing = pageKeys(["notes/alpha.md"]);
    const byFile = storedOutlinks({ "notes/alpha.md": "prose only, no links" });
    expect(danglingTargets(existing, byFile)).toEqual([]);
  });

  it("D7 — results are sorted by key for deterministic payloads", () => {
    const existing = pageKeys(["notes/alpha.md"]);
    const byFile = storedOutlinks({
      "notes/alpha.md": "[[zed]] then [[abe]] then [[mid]]",
    });
    expect(danglingTargets(existing, byFile).map((d) => d.key)).toEqual([
      "abe",
      "mid",
      "zed",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// A1 — taproot_prune broken-link resolver unification. The prune handler's
// ad-hoc regex /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g + `.toLowerCase().replace(\s+,-)`
// (knowledge.ts:1171) diverges from the canonical write-path resolver: it does
// NOT strip code fences / inline code and does NOT strip a `#heading`. So today
// it reports fenced, inline, and `#heading` links as BROKEN — false positives.
// After A1 (resolve via outlinkKeys/linkKey) only a genuinely-missing target is
// broken. RED on current code (the false positives appear in the report).
// ─────────────────────────────────────────────────────────────────────────

type ToolHandler = (input: Record<string, unknown>) => Promise<{
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

/** Backend over an in-memory notes/ corpus. No config file → prune defaults to
 * the "notes" folder. */
function pruneBackend(files: Record<string, string>): StorageBackend {
  const paths = Object.keys(files);
  return {
    readFile: vi.fn(async (p: string) => {
      if (p in files) return files[p];
      throw new Error(`not found: ${p}`);
    }),
    writeFile: vi.fn(async () => undefined),
    listFiles: vi.fn(async (sub?: string) =>
      sub ? paths.filter((f) => f === sub || f.startsWith(sub + "/")) : paths,
    ),
    exists: vi.fn(async (p: string) => p === "notes"),
    mkdir: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: 0, modifiedAt: new Date() })),
    recentFiles: vi.fn(async () => []),
    listChanged: vi.fn(async () => ({ files: [], next: null })),
  } as unknown as StorageBackend;
}

const FM = "---\ntitle: T\ntype: note\ndate_created: 2026-06-01\n---\n";

describe("A1 — taproot_prune broken-link detection uses the canonical resolver", () => {
  let capture: ReturnType<typeof makeServerCapture>;
  beforeEach(() => {
    capture = makeServerCapture();
  });

  async function runPrune(files: Record<string, string>): Promise<string> {
    registerKnowledgeTools(capture.server, pruneBackend(files));
    const prune = capture.registered.get("taproot_prune")!;
    const res = await prune({});
    return res.content.map((c) => c.text).join("\n");
  }

  it("A1-1 — a genuinely-missing target IS reported broken (baseline)", async () => {
    const text = await runPrune({
      "notes/target.md": FM + "# Target\n",
      "notes/src.md": FM + "Broken [[ghost]].\n",
    });
    expect(text).toContain("[[ghost]]");
  });

  it("A1-2 — a code-fenced / inline-code wikilink is NOT reported broken", async () => {
    const text = await runPrune({
      "notes/target.md": FM + "# Target\n",
      "notes/src.md":
        FM +
        [
          "Real [[ghost]] is broken.",
          "```",
          "[[fenced-ghost]] in a fence",
          "```",
          "Inline `[[inline-ghost]]` span.",
        ].join("\n"),
    });
    expect(text).toContain("[[ghost]]"); // the real one still reported
    expect(text).not.toContain("fenced-ghost");
    expect(text).not.toContain("inline-ghost");
  });

  it("A1-3 — a #heading / |alias link to an existing page is NOT reported broken", async () => {
    const text = await runPrune({
      "notes/target.md": FM + "# Target\n",
      "notes/src.md":
        FM + "Heading [[target#Section]] and alias [[target|Display]].\n",
    });
    // `target` exists; neither the heading nor the alias form is broken.
    expect(text).not.toMatch(/\[\[target#/);
    expect(text).not.toMatch(/\[\[target\|/);
  });
});
