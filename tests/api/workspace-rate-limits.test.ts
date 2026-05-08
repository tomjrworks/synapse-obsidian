import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import {
  workspaceLimitMiddleware,
  userIdLimitMiddleware,
} from "../../src/api/middleware.js";

// ---------------------------------------------------------------------------
// Smoke for Phase 4 workspace-keyed rate limiters (H4–H10, H12).
//
// Spins up minimal Express apps — no Supabase, no backend — and stamps
// req.workspaceId / req.user.id directly (mirrors what auth middleware does
// in production). Tests that `cap+1` requests 429 and that a second workspace
// / user is independent.
// ---------------------------------------------------------------------------

// Stub auth that seeds workspaceId onto the request.
function seedWorkspace(wsId: string) {
  return (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    (_req as Record<string, unknown>).workspaceId = wsId;
    next();
  };
}

// Stub auth that seeds user.id onto the request (for userIdLimitMiddleware).
function seedUser(userId: string) {
  return (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    (_req as Record<string, unknown>).user = { id: userId };
    next();
  };
}

// Spin up an Express app with one POST /test route gated by `middleware`.
// Returns the server + its baseUrl.
function makeApp(
  seeder: express.RequestHandler,
  middleware: express.RequestHandler,
): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.post("/test", seeder, middleware, (_req, res) =>
      res.status(200).json({ ok: true }),
    );
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function post(baseUrl: string) {
  return fetch(`${baseUrl}/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

describe("workspaceLimitMiddleware (H4–H10, H12)", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    // Cap of 3 so tests stay fast. Proves the mechanism without 60+ round trips.
    ({ server, baseUrl } = await makeApp(
      seedWorkspace("ws-a"),
      workspaceLimitMiddleware(3, 60),
    ));
  });

  afterAll(() => server.close());

  it("allows requests under the cap", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await post(baseUrl);
      expect(r.status).toBe(200);
    }
  });

  it("429s the request over the cap for the same workspace", async () => {
    const r = await post(baseUrl);
    expect(r.status).toBe(429);
  });
});

describe("workspaceLimitMiddleware — workspace buckets are independent", () => {
  let serverA: Server;
  let serverB: Server;
  let urlA: string;
  let urlB: string;

  beforeAll(async () => {
    ({ server: serverA, baseUrl: urlA } = await makeApp(
      seedWorkspace("ws-x"),
      workspaceLimitMiddleware(2, 60),
    ));
    ({ server: serverB, baseUrl: urlB } = await makeApp(
      seedWorkspace("ws-y"),
      workspaceLimitMiddleware(2, 60),
    ));
  });

  afterAll(() => {
    serverA.close();
    serverB.close();
  });

  it("exhausts ws-x without affecting ws-y", async () => {
    // Fill ws-x bucket
    await post(urlA);
    await post(urlA);
    const blocked = await post(urlA);
    expect(blocked.status).toBe(429);

    // ws-y is a different bucket — should still pass
    const r = await post(urlB);
    expect(r.status).toBe(200);
  });
});

describe("userIdLimitMiddleware (workspace-create H12)", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await makeApp(
      seedUser("user-1"),
      userIdLimitMiddleware(2, 60),
    ));
  });

  afterAll(() => server.close());

  it("allows requests under the cap", async () => {
    for (let i = 0; i < 2; i++) {
      const r = await post(baseUrl);
      expect(r.status).toBe(200);
    }
  });

  it("429s the request over the cap for the same user", async () => {
    const r = await post(baseUrl);
    expect(r.status).toBe(429);
  });
});
