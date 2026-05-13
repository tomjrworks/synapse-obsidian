import { describe, it, expect } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { syncRouter } from "../../src/api/sync.js";
import type { ListChangedResult } from "../../src/utils/storage.js";

// ---------------------------------------------------------------------------
// Smoke tests for GET /api/sync/pull — focused on pending_count (S2) and
// blob-timeout skip behavior surfaced through the handler response.
//
// Uses syncRouter's SyncRouterOptions seams (requireAuth + getBackend) to
// avoid Supabase. Spins up a real Express server on an ephemeral port.
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

function makeServer(
  result: ListChangedResult,
  cursorHead: { modifiedAt: string; id: string } | null = null,
): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const wsId = "ws-test-pull";
    const app = express();
    app.use(express.json());
    app.use(
      syncRouter({
        requireAuth: seedWorkspace(wsId),
        requireSubscription: (_req, _res, next) => next(),
        getBackend: async () => ({
          writeFile: async () => {},
          delete: async () => {},
          listChanged: async () => result,
          getCursorHead: async () => cursorHead,
          getPendingCount: async () => 0,
        }),
      }),
    );
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function pullJson(
  baseUrl: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params).toString();
  const url = `${baseUrl}/sync/pull${qs ? `?${qs}` : ""}`;
  const res = await fetch(url);
  return res.json() as Promise<Record<string, unknown>>;
}

describe("GET /api/sync/pull — pending_count", () => {
  it("includes pending_count: 0 when backend returns 0 remaining (caught up)", async () => {
    const { server, baseUrl } = await makeServer({
      files: [],
      next: null,
      pendingCount: 0,
    });
    try {
      const body = await pullJson(baseUrl);
      expect(body.pending_count).toBe(0);
      expect(body.files).toEqual([]);
      expect(body.next_since).toBeNull();
      expect(body.next_since_id).toBeNull();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("includes pending_count: N when backend reports N rows remaining", async () => {
    const { server, baseUrl } = await makeServer({
      files: [
        {
          path: "notes/foo.md",
          size: 42,
          modifiedAt: "2026-05-09T00:00:00Z",
          id: "11111111-0000-0000-0000-000000000001",
          deleted: false,
          content: "hello",
        },
      ],
      next: {
        modifiedAt: "2026-05-09T00:00:00Z",
        id: "11111111-0000-0000-0000-000000000001",
      },
      pendingCount: 17,
    });
    try {
      const body = await pullJson(baseUrl);
      expect(body.pending_count).toBe(17);
      expect((body.files as unknown[]).length).toBe(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("returns pending_count: 0 on an empty pull with a cursor (cursor at head)", async () => {
    const cursor = {
      since: "2026-05-09T00:00:00Z",
      since_id: "22222222-0000-0000-0000-000000000002",
    };
    const { server, baseUrl } = await makeServer({
      files: [],
      next: {
        modifiedAt: cursor.since,
        id: cursor.since_id,
      },
      pendingCount: 0,
    });
    try {
      const body = await pullJson(baseUrl, cursor);
      expect(body.pending_count).toBe(0);
      expect(body.files).toEqual([]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("skips a transient-timeout row (does not mark it deleted) — handler receives fewer files than DB rows", async () => {
    // Simulates S1 behavior: listChanged already skips the broken row and
    // returns it neither in files[] nor as a tombstone. The response should
    // reflect the reduced file count, not a deleted: true entry.
    const { server, baseUrl } = await makeServer({
      // listChanged returned 1 good file; the broken blob was skipped
      files: [
        {
          path: "notes/good.md",
          size: 10,
          modifiedAt: "2026-05-09T00:01:00Z",
          id: "33333333-0000-0000-0000-000000000003",
          deleted: false,
          content: "good content",
        },
      ],
      next: {
        modifiedAt: "2026-05-09T00:01:00Z",
        id: "33333333-0000-0000-0000-000000000003",
      },
      pendingCount: 0,
    });
    try {
      const body = await pullJson(baseUrl);
      const files = body.files as Array<{ deleted: boolean; path: string }>;
      expect(files.length).toBe(1);
      expect(files[0].deleted).toBe(false);
      expect(files[0].path).toBe("notes/good.md");
      expect(body.pending_count).toBe(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("GET /api/sync/cursor-head", () => {
  it("returns next_since + next_since_id when workspace has files", async () => {
    const head = {
      modifiedAt: "2026-05-09T12:00:00Z",
      id: "aaaaaaaa-0000-0000-0000-000000000001",
    };
    const { server, baseUrl } = await makeServer(
      { files: [], next: null, pendingCount: 0 },
      head,
    );
    try {
      const res = await fetch(`${baseUrl}/sync/cursor-head`);
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(200);
      expect(body.next_since).toBe(head.modifiedAt);
      expect(body.next_since_id).toBe(head.id);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("returns null cursors when workspace is empty", async () => {
    const { server, baseUrl } = await makeServer(
      { files: [], next: null, pendingCount: 0 },
      null,
    );
    try {
      const res = await fetch(`${baseUrl}/sync/cursor-head`);
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(200);
      expect(body.next_since).toBeNull();
      expect(body.next_since_id).toBeNull();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
