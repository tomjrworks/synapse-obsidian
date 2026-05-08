import { describe, it, expect, vi } from "vitest";
import { personaRenderRouter } from "../../src/api/persona-render.js";

// ---------------------------------------------------------------------------
// Minimal test harness — avoids spinning up Express; calls the router handler
// directly by extracting it via a mock router capture.
// ---------------------------------------------------------------------------

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
  // bind methods so `this` works
  res.json = res.json.bind(res);
  res.status = res.status.bind(res);
  return res;
}

function makeReq(settings: Record<string, unknown> = {}) {
  return {
    membership: {
      workspaceId: "ws-test",
      name: "Test",
      settings,
    },
    body: {},
    header: vi.fn(() => "Bearer fake-jwt"),
  };
}

function makeBackend(
  overrides: {
    readFile?: (p: string) => Promise<string>;
    writeFile?: (p: string, c: string) => Promise<void>;
  } = {},
) {
  return {
    readFile: vi.fn(overrides.readFile ?? (async () => "")),
    writeFile: vi.fn(overrides.writeFile ?? (async () => undefined)),
    listFiles: vi.fn(async () => []),
    exists: vi.fn(async () => false),
    mkdir: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: 0, modifiedAt: new Date() })),
    recentFiles: vi.fn(async () => []),
    listChanged: vi.fn(async () => ({ files: [], next: null })),
  };
}

// Extract the actual POST handler from the router
async function callHandler(
  req: ReturnType<typeof makeReq>,
  res: ReturnType<typeof makeRes>,
) {
  // Build a minimal next() that records errors
  const errors: unknown[] = [];
  const next = (err?: unknown) => {
    if (err) errors.push(err);
  };

  // personaRenderRouter() registers POST /persona/render.
  // We reach the handler directly by capturing it via the mock asyncHandler.
  // Since asyncHandler is mocked to return `fn` unwrapped, the route handler
  // is the 3rd argument to router.post(). We exercise it by building the router
  // and calling handle on a fake req.
  const router = personaRenderRouter();

  // Simulate express routing by calling router.handle
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
    // Also resolve after a tick in case handler ends response synchronously
    setTimeout(resolve, 50);
  });

  return { json: res._json, status: res._status, errors };
}

describe("POST /api/persona/render", () => {
  it("returns no_persona_set when settings.persona is absent", async () => {
    const mockBackend = makeBackend();
    vi.mocked(getBackend).mockResolvedValue(mockBackend as never);

    const req = makeReq({ persona: null });
    const res = makeRes();
    await callHandler(req, res);

    expect(res._json).toMatchObject({
      written: false,
      reason: "no_persona_set",
    });
    expect(mockBackend.writeFile).not.toHaveBeenCalled();
  });

  it("returns no_persona_set when traits and freetext are both empty", async () => {
    const mockBackend = makeBackend();
    vi.mocked(getBackend).mockResolvedValue(mockBackend as never);

    const req = makeReq({ persona: { traits: [], freetext: "   " } });
    const res = makeRes();
    await callHandler(req, res);

    expect(res._json).toMatchObject({
      written: false,
      reason: "no_persona_set",
    });
  });

  it("writes fresh CLAUDE.md when persona set and no existing file", async () => {
    const mockBackend = makeBackend({
      readFile: async (p: string) => {
        if (p === "CLAUDE.md") throw new NotFoundError("CLAUDE.md");
        return "";
      },
    });
    vi.mocked(getBackend).mockResolvedValue(mockBackend as never);

    const req = makeReq({ persona: { traits: ["founder"], freetext: "" } });
    const res = makeRes();
    await callHandler(req, res);

    expect(res._json).toMatchObject({ written: true, path: "CLAUDE.md" });
    expect(mockBackend.writeFile).toHaveBeenCalledWith(
      "CLAUDE.md",
      expect.stringContaining(SECTION_MARKER_START("filing")),
    );
  });

  it("merges into existing CLAUDE.md with markers", async () => {
    // Build a minimal existing CLAUDE.md with all three managed sections
    const existingClaudeMd = [
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
      readFile: async (p: string) => {
        if (p === "CLAUDE.md") return existingClaudeMd;
        return "";
      },
    });
    vi.mocked(getBackend).mockResolvedValue(mockBackend as never);

    const req = makeReq({ persona: { traits: ["founder"], freetext: "" } });
    const res = makeRes();
    await callHandler(req, res);

    expect(res._json).toMatchObject({ written: true, path: "CLAUDE.md" });
    const written = vi.mocked(mockBackend.writeFile).mock
      .calls[0]?.[1] as string;
    // Managed sections replaced
    expect(written).toContain(SECTION_MARKER_START("filing"));
    expect(written).not.toContain("old filing content");
  });

  it("returns no_change on second call (idempotent)", async () => {
    // Write once, then read back the written content and call again
    let stored: string | null = null;

    const mockBackend = makeBackend({
      readFile: async (p: string) => {
        if (p === "CLAUDE.md") {
          if (stored === null) throw new NotFoundError("CLAUDE.md");
          return stored;
        }
        return "";
      },
      writeFile: async (_p: string, c: string) => {
        stored = c;
      },
    });
    vi.mocked(getBackend).mockResolvedValue(mockBackend as never);

    const traits = ["founder"];
    const req1 = makeReq({ persona: { traits, freetext: "" } });
    const res1 = makeRes();
    await callHandler(req1, res1);
    expect(res1._json).toMatchObject({ written: true });

    // Second call with same persona — content matches, no write
    const req2 = makeReq({ persona: { traits, freetext: "" } });
    const res2 = makeRes();
    await callHandler(req2, res2);
    expect(res2._json).toMatchObject({
      written: false,
      reason: "no_change",
    });
  });
});
