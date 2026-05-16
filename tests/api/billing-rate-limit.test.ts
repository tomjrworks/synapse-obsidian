import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

// H-D: billing routes were never retrofitted with workspaceLimitMiddleware,
// leaving POST /api/billing/checkout unbounded → Stripe API exhaustion.
//
// The limiter sits AFTER requireSupabaseAuth + requireWorkspace in the chain,
// so to exercise it we stub those two to pass through and seed a workspaceId.
// workspaceLimitMiddleware itself stays real (spread from importOriginal) —
// this proves the wiring, not the limiter mechanism (covered separately in
// workspace-rate-limits.test.ts). The M4 business routers use the same wiring.
vi.mock("../../src/api/middleware.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/api/middleware.js")>();
  const pass: express.RequestHandler = (req, _res, next) => {
    (req as Record<string, unknown>).membership = {
      workspaceId: "ws-billing-rl",
    };
    next();
  };
  return { ...actual, requireSupabaseAuth: pass, requireWorkspace: pass };
});

const { billingRouter } = await import("../../src/api/billing.js");

function makeApp(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use("/api", billingRouter());
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe("billing checkout rate limit (H-D)", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await makeApp());
  });
  afterAll(() => server.close());

  it("429s once the per-workspace cap (10/min) is exceeded", async () => {
    // Requests 1-10 pass the limiter (the handler may 400/503 — irrelevant;
    // the limiter counts every request that reaches it). Request 11 → 429.
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await fetch(`${baseUrl}/api/billing/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
