import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerVaultTools } from "../../src/tools/vault.js";
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
  const writes: Record<string, string> = {};
  const backend = {
    readFile: vi.fn(async (p: string) => {
      if (p in writes) return writes[p];
      if (p in files) return files[p];
      throw new Error(`not found: ${p}`);
    }),
    writeFile: vi.fn(async (p: string, c: string) => {
      writes[p] = c;
    }),
    listFiles: vi.fn(async () => Object.keys(files)),
    exists: vi.fn(async (p: string) => p in files),
    mkdir: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: 0, modifiedAt: new Date() })),
    recentFiles: vi.fn(async () => []),
    listChanged: vi.fn(async () => ({ files: [], next: null })),
    ...overrides,
  } as StorageBackend;
  (backend as any).__writes = writes;
  return backend;
}

describe("garden_find — date_modified surfacing", () => {
  let serverCapture: ReturnType<typeof makeServerCapture>;

  beforeEach(() => {
    serverCapture = makeServerCapture();
  });

  it("appends `(modified YYYY-MM-DD)` when frontmatter has date_modified", async () => {
    const backend = makeBackend({
      "notes/with-date.md": `---
title: With Date
date_modified: 2026-05-12T10:45:00
---

This note has a modified timestamp.
`,
    });
    registerVaultTools(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_find")!;

    const result = await handler({ query: "with-date" });
    expect(result.content[0].text).toContain("(modified 2026-05-12)");
  });

  it("omits the suffix entirely when frontmatter has no date_modified", async () => {
    const backend = makeBackend({
      "notes/plain.md": `---
title: Plain
---

No modified timestamp here.
`,
    });
    registerVaultTools(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_find")!;

    const result = await handler({ query: "plain" });
    expect(result.content[0].text).not.toContain("(modified");
  });

  it("omits the suffix when frontmatter is malformed", async () => {
    const backend = makeBackend({
      "notes/broken.md": `---
date_modified: not-a-real-date
---

body
`,
    });
    registerVaultTools(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_find")!;

    const result = await handler({ query: "broken" });
    // Either parsed-but-unnormalizable → no suffix, or parse error → no suffix
    expect(result.content[0].text).not.toContain("(modified");
  });
});

describe("garden_forage — date_modified surfacing", () => {
  let serverCapture: ReturnType<typeof makeServerCapture>;

  beforeEach(() => {
    serverCapture = makeServerCapture();
  });

  it("appends modified date to result header when present", async () => {
    const backend = makeBackend({
      "notes/foo.md": `---
title: Foo
date_modified: 2026-05-12T10:45:00
---

This contains the search target keyword.
`,
    });
    registerVaultTools(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_forage")!;

    const result = await handler({ query: "target keyword" });
    expect(result.content[0].text).toContain("(modified 2026-05-12)");
  });

  it("omits suffix when result file has no date_modified", async () => {
    const backend = makeBackend({
      "notes/foo.md": `# Plain
This contains the search target keyword.
`,
    });
    registerVaultTools(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_forage")!;

    const result = await handler({ query: "target keyword" });
    expect(result.content[0].text).toContain("notes/foo.md");
    expect(result.content[0].text).not.toContain("(modified");
  });
});

describe("garden_plant — gated date_modified injection", () => {
  let serverCapture: ReturnType<typeof makeServerCapture>;
  const originalEnv = process.env.GARDEN_PLANT_DATE_INJECT;

  beforeEach(() => {
    serverCapture = makeServerCapture();
    delete process.env.GARDEN_PLANT_DATE_INJECT;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.GARDEN_PLANT_DATE_INJECT;
    else process.env.GARDEN_PLANT_DATE_INJECT = originalEnv;
  });

  it("gate OFF (default) → content written byte-for-byte unchanged", async () => {
    const backend = makeBackend({});
    registerVaultTools(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_plant")!;
    const body = `---
title: Test
---

body
`;

    await handler({ path: "inbox/test.md", content: body });
    expect((backend as any).__writes["inbox/test.md"]).toBe(body);
  });

  it("gate ON + frontmatter present → date_modified injected", async () => {
    process.env.GARDEN_PLANT_DATE_INJECT = "1";
    const backend = makeBackend({});
    registerVaultTools(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_plant")!;
    const body = `---
title: Test
---

body
`;

    await handler({ path: "inbox/test.md", content: body });
    const written = (backend as any).__writes["inbox/test.md"];
    expect(written).toContain("date_modified:");
    expect(written).toContain("title: Test");
    expect(written).toContain("body");
  });

  it("gate ON + no frontmatter → content unchanged", async () => {
    process.env.GARDEN_PLANT_DATE_INJECT = "1";
    const backend = makeBackend({});
    registerVaultTools(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_plant")!;
    const body = "# Plain note\n\nNo frontmatter.\n";

    await handler({ path: "inbox/plain.md", content: body });
    expect((backend as any).__writes["inbox/plain.md"]).toBe(body);
  });

  it("gate ON + protected path (CLAUDE.md with ack) → content unchanged", async () => {
    process.env.GARDEN_PLANT_DATE_INJECT = "1";
    const backend = makeBackend({});
    registerVaultTools(serverCapture.server, backend);
    const handler = serverCapture.registered.get("garden_plant")!;
    const body = `---
title: My CLAUDE
---

managed body
`;

    await handler({
      path: "CLAUDE.md",
      content: body,
      acknowledgeRoot: true,
    });
    expect((backend as any).__writes["CLAUDE.md"]).toBe(body);
  });
});
