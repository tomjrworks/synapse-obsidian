import { describe, it, expect, vi } from "vitest";
import { personaRenderRouter } from "../../src/api/persona-render.js";

vi.mock("../../src/utils/backend-cache.js", () => ({
  getBackend: vi.fn(),
}));

vi.mock("../../src/api/middleware.js", () => ({
  requireSupabaseAuth: vi.fn((_req: unknown, _res: unknown, next: () => void) =>
    next(),
  ),
  requireWorkspace: vi.fn((_req: unknown, _res: unknown, next: () => void) =>
    next(),
  ),
  asyncHandler: vi.fn(
    (fn: (req: unknown, res: unknown, next: () => void) => Promise<void>) => fn,
  ),
  workspaceLimitMiddleware: vi.fn(() =>
    vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  ),
  userIdLimitMiddleware: vi.fn(() =>
    vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  ),
}));

import { getBackend } from "../../src/utils/backend-cache.js";
import {
  SECTION_MARKER_START,
  SECTION_MARKER_END,
} from "../../src/tools/persona-claudemd.js";
import { NotFoundError } from "../../src/utils/storage.js";

function makeRes() {
  const res = {
    _json: null as unknown,
    _status: 200,
    json: vi.fn(function (this: ReturnType<typeof makeRes>, body: unknown) {
      this._json = body;
      return this;
    }),
    status: vi.fn(function (this: ReturnType<typeof makeRes>, code: number) {
      this._status = code;
      return this;
    }),
  };
  res.json = res.json.bind(res);
  res.status = res.status.bind(res);
  return res;
}

function makeReq(settings: Record<string, unknown> = {}) {
  return {
    membership: { workspaceId: "ws-test", name: "Test", settings },
    body: {},
    header: vi.fn(() => "Bearer fake-jwt"),
  };
}

function makeBackend(
  overrides: {
    readFile?: (p: string) => Promise<string>;
    writeFile?: (p: string, c: string) => Promise<void>;
    files?: string[];
  } = {},
) {
  return {
    readFile: vi.fn(overrides.readFile ?? (async () => "")),
    writeFile: vi.fn(overrides.writeFile ?? (async () => undefined)),
    listFiles: vi.fn(async () => overrides.files ?? []),
    exists: vi.fn(async () => false),
    mkdir: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: 0, modifiedAt: new Date() })),
    recentFiles: vi.fn(async () => []),
    listChanged: vi.fn(async () => ({ files: [], next: null })),
  };
}

async function callHandler(
  req: ReturnType<typeof makeReq>,
  res: ReturnType<typeof makeRes>,
) {
  const router = personaRenderRouter();
  await new Promise<void>((resolve) => {
    (router as unknown as { handle: Function }).handle(
      Object.assign(req, {
        path: "/persona/render",
        method: "POST",
        url: "/persona/render",
      }),
      res,
      () => resolve(),
    );
    setTimeout(resolve, 50);
  });
  return { json: res._json, status: res._status };
}

describe("POST /api/persona/render", () => {
  it("writes a fresh CLAUDE.md scaffold when none exists", async () => {
    const mockBackend = makeBackend({
      readFile: async (p: string) => {
        if (p === "CLAUDE.md") throw new NotFoundError("CLAUDE.md");
        return "";
      },
    });
    vi.mocked(getBackend).mockResolvedValue(mockBackend as never);

    const req = makeReq({});
    const res = makeRes();
    await callHandler(req, res);

    expect(res._json).toMatchObject({
      written: true,
      path: "CLAUDE.md",
      claudemd_status: "written",
    });
    expect(mockBackend.writeFile).toHaveBeenCalledWith(
      "CLAUDE.md",
      expect.stringContaining(SECTION_MARKER_START("filing")),
    );
  });

  it("emits the observed folder list (no fabricated folders)", async () => {
    const files = ["projects/p.md", "daily/2026-05-11.md", "cooking/recipe.md"];
    const mockBackend = makeBackend({
      readFile: async (p: string) => {
        if (p === "CLAUDE.md") throw new NotFoundError("CLAUDE.md");
        if (files.includes(p)) return "";
        return "";
      },
      files,
    });
    vi.mocked(getBackend).mockResolvedValue(mockBackend as never);

    const req = makeReq({});
    const res = makeRes();
    await callHandler(req, res);

    const written = vi.mocked(mockBackend.writeFile).mock
      .calls[0]?.[1] as string;
    expect(written).toContain("`projects/`");
    expect(written).toContain("`daily/`");
    expect(written).toContain("`cooking/`");
    // No fabricated trait folders from the legacy templates
    expect(written).not.toContain("`metrics/`");
    expect(written).not.toContain("`playbook/`");
  });

  it("skips when CLAUDE.md is user-owned (substantive, no markers)", async () => {
    const userContent =
      "# My CLAUDE.md\n\n" + "I keep my own filing rules here. ".repeat(20);
    const mockBackend = makeBackend({
      readFile: async (p: string) => (p === "CLAUDE.md" ? userContent : ""),
    });
    vi.mocked(getBackend).mockResolvedValue(mockBackend as never);

    const req = makeReq({});
    const res = makeRes();
    await callHandler(req, res);

    expect(res._json).toMatchObject({
      written: false,
      reason: "skipped_user_owned",
      claudemd_status: "skipped_user_owned",
    });
    expect(mockBackend.writeFile).not.toHaveBeenCalled();
  });

  it("merges into existing taproot-managed CLAUDE.md", async () => {
    const existing = [
      SECTION_MARKER_START("filing"),
      "old filing content",
      SECTION_MARKER_END("filing"),
      SECTION_MARKER_START("traits"),
      "old traits content",
      SECTION_MARKER_END("traits"),
      SECTION_MARKER_START("conventions"),
      "old conventions content",
      SECTION_MARKER_END("conventions"),
    ].join("\n");

    const mockBackend = makeBackend({
      readFile: async (p: string) => (p === "CLAUDE.md" ? existing : ""),
    });
    vi.mocked(getBackend).mockResolvedValue(mockBackend as never);

    const req = makeReq({});
    const res = makeRes();
    await callHandler(req, res);

    expect(res._json).toMatchObject({
      written: true,
      claudemd_status: "merged",
    });
    const written = vi.mocked(mockBackend.writeFile).mock
      .calls[0]?.[1] as string;
    expect(written).toContain(SECTION_MARKER_START("filing"));
    expect(written).not.toContain("old filing content");
  });

  it("returns no_change on second call (idempotent)", async () => {
    let stored: string | null = null;
    const mockBackend = makeBackend({
      readFile: async (p: string) => {
        if (p !== "CLAUDE.md") return "";
        if (stored === null) throw new NotFoundError("CLAUDE.md");
        return stored;
      },
      writeFile: async (_p: string, c: string) => {
        stored = c;
      },
    });
    vi.mocked(getBackend).mockResolvedValue(mockBackend as never);

    const req1 = makeReq({});
    const res1 = makeRes();
    await callHandler(req1, res1);
    expect(res1._json).toMatchObject({ written: true });

    // Second call: classifier sees taproot_managed; merge yields same content
    const req2 = makeReq({});
    const res2 = makeRes();
    await callHandler(req2, res2);
    expect(res2._json).toMatchObject({
      written: false,
      reason: "no_change",
    });
  });
});
