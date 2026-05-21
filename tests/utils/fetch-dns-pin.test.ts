import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// S63 (2026-05-21): pin DNS at validate-time to prevent rebinding TOCTOU.
//
// Six load-bearing cases (see plan):
//   1. assertNotPrivate returns IP list (contract change void → string[])
//   2. validateUrl propagates validatedIp
//   3. Pin holds under rebinding (lookup returns public IP at validate,
//      attacker DNS would return 127.0.0.1 at fetch — we connect to the pin)
//   4. Per-hop re-pin on redirect (LOAD-BEARING — without this, redirect to
//      hostile-DNS hostname bypasses the original pin)
//   5. Private IP rejected at validate (H4/H2 sanity — not regressed)
//   6. IPv6 family is set correctly

// --- hoisted mock surfaces ------------------------------------------------

const h = vi.hoisted(() => {
  const mockDnsLookup = vi.fn();
  const mockUndiciFetch = vi.fn();
  const agentConstructions: Array<{
    options: { connect: { lookup: Function } };
    close: () => Promise<void>;
  }> = [];
  return { mockDnsLookup, mockUndiciFetch, agentConstructions };
});

vi.mock("node:dns", () => ({
  promises: {
    lookup: (...args: unknown[]) => h.mockDnsLookup(...args),
  },
}));

vi.mock("undici", () => {
  class MockAgent {
    options: { connect: { lookup: Function } };
    constructor(options: { connect: { lookup: Function } }) {
      this.options = options;
      const entry = { options, close: async () => {} };
      h.agentConstructions.push(entry);
    }
    async close() {
      /* no-op for test */
    }
  }
  return {
    Agent: MockAgent,
    fetch: (...args: unknown[]) => h.mockUndiciFetch(...args),
  };
});

// Import AFTER mocks so the module under test binds to mocked symbols.
import {
  assertNotPrivate,
  validateUrl,
  fetchUrlAsText,
} from "../../src/utils/fetch.js";

beforeEach(() => {
  h.mockDnsLookup.mockReset();
  h.mockUndiciFetch.mockReset();
  h.agentConstructions.length = 0;
  // Default: no allow-private; tests opt in per-case if needed.
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function dnsResult(...addrs: string[]) {
  return addrs.map((address) => ({
    address,
    family: address.includes(":") ? 6 : 4,
  }));
}

function okResponse(body = "hello", contentType = "text/plain"): Response {
  return new Response(Buffer.from(body, "utf8"), {
    status: 200,
    headers: { "content-type": contentType },
  });
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location },
  });
}

describe("S63 — DNS pinning at validate-time", () => {
  it("1. assertNotPrivate returns the resolved IP list (contract change)", async () => {
    h.mockDnsLookup.mockResolvedValueOnce(dnsResult("1.2.3.4"));
    const addrs = await assertNotPrivate("example.com");
    expect(addrs).toEqual(["1.2.3.4"]);
  });

  it("2. validateUrl propagates the first resolved IP as validatedIp", async () => {
    h.mockDnsLookup.mockResolvedValueOnce(dnsResult("1.2.3.4"));
    const result = await validateUrl("https://example.com/foo");
    expect(result.validatedIp).toBe("1.2.3.4");
    expect(result.url.hostname).toBe("example.com");
  });

  it("3. Pin holds under DNS rebinding (Agent connect.lookup returns the pin, not fresh DNS)", async () => {
    // First call (at validate) — public IP.
    // Second call (would be undici's independent lookup if not pinned) — private.
    h.mockDnsLookup
      .mockResolvedValueOnce(dnsResult("1.2.3.4"))
      .mockResolvedValueOnce(dnsResult("127.0.0.1"));
    h.mockUndiciFetch.mockResolvedValueOnce(okResponse("pinned ok"));

    const result = await fetchUrlAsText("https://example.com/");
    expect(result.body).toBe("pinned ok");

    // Exactly one Agent constructed (no redirect).
    expect(h.agentConstructions).toHaveLength(1);

    // Invoke the lookup callback the way undici would and assert we get the
    // VALIDATED IP back, not whatever the second (hostile) DNS lookup would
    // return.
    const cb = vi.fn();
    h.agentConstructions[0].options.connect.lookup(
      "example.com",
      {},
      (err: unknown, address: string, family: number) =>
        cb(err, address, family),
    );
    expect(cb).toHaveBeenCalledWith(null, "1.2.3.4", 4);
  });

  it("4. Per-hop re-pin on redirect (load-bearing — second Agent uses the NEW host's IP)", async () => {
    // Hop A: hostA → 1.2.3.4. Then 302 to https://hostB/.
    // Hop B: hostB → 5.6.7.8. Then 200 OK.
    h.mockDnsLookup
      .mockResolvedValueOnce(dnsResult("1.2.3.4")) // validate hostA
      .mockResolvedValueOnce(dnsResult("5.6.7.8")); // validate hostB (re-pin)
    h.mockUndiciFetch
      .mockResolvedValueOnce(redirectResponse("https://hostb.example/"))
      .mockResolvedValueOnce(okResponse("hop-b body"));

    const result = await fetchUrlAsText("https://hosta.example/start");
    expect(result.body).toBe("hop-b body");

    // Two Agents constructed (one per hop), each pinned to ITS hop's IP.
    expect(h.agentConstructions).toHaveLength(2);

    const cb1 = vi.fn();
    h.agentConstructions[0].options.connect.lookup(
      "hosta.example",
      {},
      (e: unknown, a: string, f: number) => cb1(e, a, f),
    );
    expect(cb1).toHaveBeenCalledWith(null, "1.2.3.4", 4);

    const cb2 = vi.fn();
    h.agentConstructions[1].options.connect.lookup(
      "hostb.example",
      {},
      (e: unknown, a: string, f: number) => cb2(e, a, f),
    );
    // CRITICAL: the second Agent must be pinned to hostB's IP (5.6.7.8),
    // NOT carried over from hop A (1.2.3.4) and NOT whatever live DNS for
    // hostB would currently return.
    expect(cb2).toHaveBeenCalledWith(null, "5.6.7.8", 4);
  });

  it("5. Private IP rejected at validate (H4/H2 sanity — not regressed by S63 refactor)", async () => {
    h.mockDnsLookup.mockResolvedValueOnce(dnsResult("127.0.0.1"));
    await expect(assertNotPrivate("evil.example")).rejects.toThrow(
      /blocked private IP: evil\.example resolves to 127\.0\.0\.1/,
    );
  });

  it("6. IPv6 family is set correctly on the pinned lookup callback", async () => {
    h.mockDnsLookup.mockResolvedValueOnce(dnsResult("2606:4700::1"));
    h.mockUndiciFetch.mockResolvedValueOnce(okResponse("v6 ok"));

    await fetchUrlAsText("https://v6.example/");

    expect(h.agentConstructions).toHaveLength(1);
    const cb = vi.fn();
    h.agentConstructions[0].options.connect.lookup(
      "v6.example",
      {},
      (e: unknown, a: string, f: number) => cb(e, a, f),
    );
    expect(cb).toHaveBeenCalledWith(null, "2606:4700::1", 6);
  });
});
