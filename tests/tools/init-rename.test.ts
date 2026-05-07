import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInitTools } from "../../src/tools/init.js";
import type { StorageBackend } from "../../src/utils/storage.js";

function makeBackend(): StorageBackend {
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
  } as StorageBackend;
}

interface Registered {
  config: { title?: string; description?: string };
  handler: (args: unknown) => Promise<unknown>;
}

function captureRegistrations() {
  const registered = new Map<string, Registered>();
  const server = {
    registerTool: vi.fn(
      (
        name: string,
        config: { title?: string; description?: string },
        handler: (args: unknown) => Promise<unknown>,
      ) => {
        registered.set(name, { config, handler });
      },
    ),
  } as unknown as McpServer;
  return { server, registered };
}

describe("F8 — taproot_plant deprecation shim", () => {
  it("registers both taproot_setup_scan and taproot_plant", () => {
    const { server, registered } = captureRegistrations();
    registerInitTools(server, makeBackend());
    expect(registered.has("taproot_setup_scan")).toBe(true);
    expect(registered.has("taproot_plant")).toBe(true);
  });

  it("the deprecated alias description leads with [deprecated", () => {
    const { server, registered } = captureRegistrations();
    registerInitTools(server, makeBackend());
    const alias = registered.get("taproot_plant");
    expect(alias?.config.description).toMatch(/^\[deprecated/);
  });

  it("the canonical taproot_setup_scan description does NOT include [deprecated", () => {
    const { server, registered } = captureRegistrations();
    registerInitTools(server, makeBackend());
    const canonical = registered.get("taproot_setup_scan");
    expect(canonical?.config.description ?? "").not.toContain("[deprecated");
  });

  it("both names point at the same handler reference (shared closure)", () => {
    const { server, registered } = captureRegistrations();
    registerInitTools(server, makeBackend());
    const a = registered.get("taproot_setup_scan");
    const b = registered.get("taproot_plant");
    expect(a?.handler).toBe(b?.handler);
  });
});
