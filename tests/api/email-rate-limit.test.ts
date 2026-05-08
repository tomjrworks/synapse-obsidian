import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import rateLimit from "express-rate-limit";
import type { Server } from "node:http";

// ---------------------------------------------------------------------------
// Isolated smoke for the per-email rate limiter (H1 fix).
// Spins up a minimal Express app with just the makeEmailLimit middleware and
// a stub handler — avoids bringing in all of src/server.ts (OAuth routes,
// Supabase, etc.) while still testing real express-rate-limit behavior.
// ---------------------------------------------------------------------------

function makeEmailLimit(max: number, windowSec = 900) {
  return rateLimit({
    windowMs: windowSec * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const email = String(req.body?.email ?? "")
        .toLowerCase()
        .trim();
      return email || "no-email";
    },
    skipSuccessfulRequests: true,
    skip: (req) => {
      if (process.env.TAPROOT_DISABLE_RATE_LIMIT === "1") return true;
      if (req.method !== "POST") return true;
      const email = String(req.body?.email ?? "")
        .toLowerCase()
        .trim();
      return email === "";
    },
  });
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Cap of 3 so the smoke stays fast — proves the mechanism without 5 round trips.
  app.use("/authorize", makeEmailLimit(3));
  // Stub handler always returns 400 (simulates wrong credentials).
  app.post("/authorize", (_req, res) =>
    res.status(400).json({ error: "bad_credentials" }),
  );
  app.get("/authorize", (_req, res) => res.status(200).json({ ok: true }));

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server.close();
});

async function post(email: string, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ email }),
  });
}

describe("per-email rate limiter (H1)", () => {
  it("allows requests under the cap (3 failed attempts → all 400)", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await post("victim@example.com");
      expect(r.status).toBe(400);
    }
  });

  it("blocks the 4th request for the same email regardless of IP", async () => {
    // 4th attempt (same email) — should hit the 429 wall.
    const r = await post("victim@example.com", {
      "X-Forwarded-For": "1.2.3.4",
    });
    expect(r.status).toBe(429);
  });

  it("allows a different email through while the first is blocked", async () => {
    // Different email → independent bucket → should reach the handler (400).
    const r = await post("other@example.com");
    expect(r.status).toBe(400);
  });

  it("does not rate-limit GET requests (consent page renders)", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${baseUrl}/authorize?email=victim@example.com`);
      expect(r.status).toBe(200);
    }
  });

  it("does not rate-limit POSTs with no email field (falls through to handler)", async () => {
    const r = await fetch(`${baseUrl}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    // No email → skip fires → handler runs → 400 from stub (not 429).
    expect(r.status).toBe(400);
  });
});
