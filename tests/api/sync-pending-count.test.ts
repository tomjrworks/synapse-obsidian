import { describe, it, expect, afterEach, beforeEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { syncRouter } from "../../src/api/sync.js";
import type { PullCursor } from "../../src/utils/storage.js";

// ---------------------------------------------------------------------------
// Smoke tests for GET /api/sync/pending-count (Blocker 1).
//
// The endpoint powers the helper's between-tick "X files behind" menu state.
// Helper calls it at the start of each pullTick BEFORE flipping to .syncing,
// passing the current keyset cursor (since + since_id). Server returns
// `{ pending_count: N }` where N is the count of vault_files rows after
// the cursor (matching listChanged's tuple ordering).
//
// Behavior contract:
//   - cursor missing  → returns { pending_count: 0 }, never calls backend
//   - PENDING_COUNT_DISABLED=1 → returns { pending_count: 0 } unconditionally
//   - cursor present  → returns count from backend.getPendingCount(cursor)
// ---------------------------------------------------------------------------

function seedWorkspace(wsId: string) {
  return (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    (req as Record<string, unknown>).workspaceId = wsId;
    next();
  };
}

interface BackendCallSpy {
  calls: Array<PullCursor | null>;
}

function makeServer(
  pendingCount: number,
  spy: BackendCallSpy = { calls: [] },
): Promise<{ server: Server; baseUrl: string; spy: BackendCallSpy }> {
  return new Promise((resolve) => {
    const wsId = "ws-test-pending-count";
    const app = express();
    app.use(express.json());
    app.use(
      syncRouter({
        requireAuth: seedWorkspace(wsId),
        requireSubscription: (_req, _res, next) => next(),
        getBackend: async () => ({
          writeFile: async () => {},
          delete: async () => {},
          listChanged: async () => ({
            files: [],
            next: null,
            pendingCount: 0,
          }),
          getCursorHead: async () => null,
          getPendingCount: async (cursor: PullCursor | null) => {
            spy.calls.push(cursor);
            return pendingCount;
          },
        }),
      }),
    );
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}`, spy });
    });
  });
}

async function pendingCountJson(
  baseUrl: string,
  params: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const qs = new URLSearchParams(params).toString();
  const url = `${baseUrl}/sync/pending-count${qs ? `?${qs}` : ""}`;
  const res = await fetch(url);
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

describe("GET /api/sync/pending-count", () => {
  const originalEnv = process.env.PENDING_COUNT_DISABLED;

  beforeEach(() => {
    delete process.env.PENDING_COUNT_DISABLED;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PENDING_COUNT_DISABLED;
    else process.env.PENDING_COUNT_DISABLED = originalEnv;
  });

  it("returns pending_count: 0 and skips the backend when no cursor params", async () => {
    const { server, baseUrl, spy } = await makeServer(42);
    try {
      const { status, body } = await pendingCountJson(baseUrl);
      expect(status).toBe(200);
      expect(body.pending_count).toBe(0);
      expect(spy.calls.length).toBe(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("returns pending_count: 0 when PENDING_COUNT_DISABLED=1 (rollback gate, never calls backend)", async () => {
    process.env.PENDING_COUNT_DISABLED = "1";
    const { server, baseUrl, spy } = await makeServer(99);
    try {
      const { status, body } = await pendingCountJson(baseUrl, {
        since: "2026-05-09T00:00:00Z",
        since_id: "11111111-0000-0000-0000-000000000001",
      });
      expect(status).toBe(200);
      expect(body.pending_count).toBe(0);
      expect(spy.calls.length).toBe(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("returns count from backend.getPendingCount when cursor params provided", async () => {
    const { server, baseUrl, spy } = await makeServer(7);
    try {
      const cursor = {
        since: "2026-05-09T00:00:00Z",
        since_id: "22222222-0000-0000-0000-000000000002",
      };
      const { status, body } = await pendingCountJson(baseUrl, cursor);
      expect(status).toBe(200);
      expect(body.pending_count).toBe(7);
      expect(spy.calls.length).toBe(1);
      expect(spy.calls[0]).toEqual({
        modifiedAt: cursor.since,
        id: cursor.since_id,
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("400s when only one of (since, since_id) is provided", async () => {
    const { server, baseUrl, spy } = await makeServer(0);
    try {
      const { status } = await pendingCountJson(baseUrl, {
        since: "2026-05-09T00:00:00Z",
      });
      expect(status).toBe(400);
      expect(spy.calls.length).toBe(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
