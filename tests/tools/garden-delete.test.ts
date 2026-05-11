import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerVaultTools } from "../../src/tools/vault.js";
import type { StorageBackend } from "../../src/utils/storage.js";

type ToolHandler = (input: { path: string }) => Promise<{
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
    exists: vi.fn(async () => true),
    mkdir: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: 0, modifiedAt: new Date() })),
    recentFiles: vi.fn(async () => []),
    listChanged: vi.fn(async () => ({ files: [], next: null })),
    ...overrides,
  } as StorageBackend;
}

describe("garden_delete", () => {
  let serverCapture: ReturnType<typeof makeServerCapture>;

  beforeEach(() => {
    serverCapture = makeServerCapture();
  });

  it("deletes a normal markdown note", async () => {
    const deleteSpy = vi.fn(async () => undefined);
    const backend = makeBackend({
      exists: vi.fn(async () => true),
      delete: deleteSpy,
    });
    registerVaultTools(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_delete")!;

    const result = await handler({ path: "inbox/test-note.md" });

    expect(deleteSpy).toHaveBeenCalledWith("inbox/test-note.md");
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/Deleted: inbox\/test-note\.md/);
  });

  it("refuses to delete CLAUDE.md (protected path)", async () => {
    const deleteSpy = vi.fn(async () => undefined);
    const backend = makeBackend({ delete: deleteSpy });
    registerVaultTools(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_delete")!;

    const result = await handler({ path: "CLAUDE.md" });

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/protected/i);
  });

  it("refuses to delete index.md (protected path)", async () => {
    const deleteSpy = vi.fn(async () => undefined);
    const backend = makeBackend({ delete: deleteSpy });
    registerVaultTools(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_delete")!;

    const result = await handler({ path: "index.md" });

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it("refuses to delete .taproot/ workspace state", async () => {
    const deleteSpy = vi.fn(async () => undefined);
    const backend = makeBackend({ delete: deleteSpy });
    registerVaultTools(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_delete")!;

    const result = await handler({ path: ".taproot/config.json" });

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/protected|\.taproot/i);
  });

  it("refuses to delete a path matching TAPROOT-IGNORE patterns", async () => {
    const claudeMdWithIgnore = `# CLAUDE.md\n<!-- TAPROOT-IGNORE\nprojects/leads/\n-->`;
    const deleteSpy = vi.fn(async () => undefined);
    const backend = makeBackend({
      exists: vi.fn(async (p: string) => p === "CLAUDE.md" || true),
      readFile: vi.fn(async (p: string) =>
        p === "CLAUDE.md" ? claudeMdWithIgnore : "",
      ),
      delete: deleteSpy,
    });
    registerVaultTools(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_delete")!;

    const result = await handler({ path: "projects/leads/contact-001.md" });

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/TAPROOT-IGNORE/);
  });

  it("refuses to delete non-markdown files", async () => {
    const deleteSpy = vi.fn(async () => undefined);
    const backend = makeBackend({ delete: deleteSpy });
    registerVaultTools(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_delete")!;

    const result = await handler({ path: "attachments/photo.png" });

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/only \.md notes/i);
  });

  it("returns clear error when file doesn't exist", async () => {
    const deleteSpy = vi.fn(async () => undefined);
    const backend = makeBackend({
      exists: vi.fn(async () => false),
      delete: deleteSpy,
    });
    registerVaultTools(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_delete")!;

    const result = await handler({ path: "inbox/missing.md" });

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/No file at/);
    expect(result.content[0].text).toMatch(/garden_find/);
  });

  it("surfaces backend errors with a friendly tool error", async () => {
    const backend = makeBackend({
      exists: vi.fn(async () => true),
      delete: vi.fn(async () => {
        throw new Error("storage 503");
      }),
    });
    registerVaultTools(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_delete")!;

    const result = await handler({ path: "inbox/test.md" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/garden_delete_failed/);
  });

  it("is registered on the server", () => {
    const backend = makeBackend();
    registerVaultTools(serverCapture.server, backend);
    expect(serverCapture.registered.has("garden_delete")).toBe(true);
  });
});
