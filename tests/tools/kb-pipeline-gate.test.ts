import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../../src/utils/storage.js";
import { registerKnowledgeTools } from "../../src/tools/knowledge.js";
import { registerInitTools } from "../../src/tools/init.js";
import { kbPipelineEnabled } from "../../src/utils/kb-pipeline-flag.js";

// ─────────────────────────────────────────────────────────────────────────
// Pass 5 — KB-pipeline behavior gate (decision 2026-06-06-pass-5-direction,
// fork 3). seed / water / cultivate / sow are removed from the DEFAULT surface
// via a behavior gate (`kbPipelineEnabled`, default OFF) returning a disabled
// response — tools stay REGISTERED (1:1 with garden-primitives.ts:504/625/725/892).
//
// RED-eval-first: the gate is NOT wired into the handlers yet, so with the flag
// OFF (the default) each tool still runs its real effect — seed/sow WRITE,
// water/cultivate return their instructions. The KB-GATE-* evals assert the
// disabled response + no write, so they fail on current code. KB-SEED-ON is the
// regression guard: seed's "save pasted raw text" capability — the one thing
// taproot_save_url does NOT cover — must survive the gating (decision: migrate it
// FIRST). It is GREEN now and must STAY GREEN through the change.
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

describe("kbPipelineEnabled — default-OFF env gate", () => {
  afterEach(() => {
    delete process.env.TAPROOT_KB_PIPELINE;
  });

  it("KB-FLAG — unset is OFF; only the literal '1' enables", () => {
    delete process.env.TAPROOT_KB_PIPELINE;
    expect(kbPipelineEnabled()).toBe(false);
    process.env.TAPROOT_KB_PIPELINE = "1";
    expect(kbPipelineEnabled()).toBe(true);
    for (const v of ["0", "true", "", "yes"]) {
      process.env.TAPROOT_KB_PIPELINE = v;
      expect(kbPipelineEnabled()).toBe(false);
    }
  });
});

describe("KB-pipeline gate — flag OFF short-circuits every pipeline tool", () => {
  let capture: ReturnType<typeof makeServerCapture>;
  let writeFile: ReturnType<typeof vi.fn>;
  let mkdir: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    delete process.env.TAPROOT_KB_PIPELINE; // default OFF
    capture = makeServerCapture();
    writeFile = vi.fn(async () => undefined);
    mkdir = vi.fn(async () => undefined);
    const backend = makeBackend({ writeFile, mkdir });
    registerKnowledgeTools(capture.server, backend);
    registerInitTools(capture.server, backend);
  });

  it("KB-GATE-seed — disabled response, never writes", async () => {
    const seed = capture.registered.get("taproot_seed")!;
    const res = await seed({
      title: "My Note",
      content: "pasted text",
      folder: "sources",
    });
    expect(res.content.map((c) => c.text).join("\n")).toMatch(/not enabled/i);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("KB-GATE-water — disabled response (no instructions)", async () => {
    const water = capture.registered.get("taproot_water")!;
    const res = await water({ sourcePath: "sources/x.md" });
    expect(res.content.map((c) => c.text).join("\n")).toMatch(/not enabled/i);
  });

  it("KB-GATE-cultivate — disabled response (no instructions)", async () => {
    const cultivate = capture.registered.get("taproot_cultivate")!;
    const res = await cultivate({});
    expect(res.content.map((c) => c.text).join("\n")).toMatch(/not enabled/i);
  });

  it("KB-GATE-sow — disabled response, never scaffolds", async () => {
    const sow = capture.registered.get("taproot_sow")!;
    const res = await sow({ topic: "DeFi protocols" });
    expect(res.content.map((c) => c.text).join("\n")).toMatch(/not enabled/i);
    expect(writeFile).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
  });
});

describe("taproot_status routing reflects the KB-pipeline gate", () => {
  function statusHandler(): ToolHandler {
    const capture = makeServerCapture();
    registerKnowledgeTools(capture.server, makeBackend());
    return capture.registered.get("taproot_status")!;
  }
  afterEach(() => {
    delete process.env.TAPROOT_KB_PIPELINE;
  });

  it("KB-STATUS-OFF — flag off: routes pasted-text→garden_plant, URL→save_url; hides pipeline tools", async () => {
    delete process.env.TAPROOT_KB_PIPELINE;
    const text = (await statusHandler()({})).content
      .map((c) => c.text)
      .join("\n");
    expect(text).toContain("garden_plant");
    expect(text).toContain("taproot_save_url");
    // The advertised tool list must not push the gated pipeline tools.
    const availLine =
      text.split("\n").find((l) => l.startsWith("**Available tools:**")) ?? "";
    expect(availLine).not.toContain("taproot_seed");
    expect(availLine).not.toContain("taproot_cultivate");
    expect(availLine).not.toContain("taproot_water");
  });

  it("KB-STATUS-ON — flag on: the legacy pipeline workflow is still advertised", async () => {
    process.env.TAPROOT_KB_PIPELINE = "1";
    const text = (await statusHandler()({})).content
      .map((c) => c.text)
      .join("\n");
    expect(text).toContain("taproot_cultivate");
  });
});

describe("KB-pipeline gate — flag ON preserves the seed pasted-text path", () => {
  let capture: ReturnType<typeof makeServerCapture>;
  let writeFile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.TAPROOT_KB_PIPELINE = "1";
    capture = makeServerCapture();
    writeFile = vi.fn(async () => undefined);
    registerKnowledgeTools(capture.server, makeBackend({ writeFile }));
  });
  afterEach(() => {
    delete process.env.TAPROOT_KB_PIPELINE;
  });

  it("KB-SEED-ON — pasted raw text still writes a source note (regression guard)", async () => {
    const seed = capture.registered.get("taproot_seed")!;
    const res = await seed({
      title: "My Research Note",
      content: "some pasted content",
      folder: "sources",
    });
    expect(res.isError).toBeUndefined();
    expect(res.content.map((c) => c.text).join("\n")).not.toMatch(
      /not enabled/i,
    );
    expect(writeFile).toHaveBeenCalledOnce();
    expect(writeFile.mock.calls[0][0]).toBe("sources/my-research-note.md");
  });
});
