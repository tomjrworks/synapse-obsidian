import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchUrlAsText } from "../../src/utils/fetch.js";

// Bypass SSRF validation for these tests.
vi.stubEnv("TAPROOT_ALLOW_PRIVATE_NETWORKS", "1");

function makeResponse(
  body: string | null,
  contentType = "text/plain",
  useStream = true,
): Response {
  if (body === null) {
    return new Response(null, {
      status: 200,
      headers: { "content-type": contentType },
    });
  }
  const bytes = Buffer.from(body, "utf8");
  if (!useStream) {
    // Simulate a response without a body stream (no ReadableStream).
    const r = new Response(bytes, {
      status: 200,
      headers: { "content-type": contentType },
    });
    Object.defineProperty(r, "body", { value: null });
    return r;
  }
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

// Patch global fetch to return a canned response.
function mockFetch(response: Response) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  // Re-stub after restore so subsequent tests still bypass SSRF.
  vi.stubEnv("TAPROOT_ALLOW_PRIVATE_NETWORKS", "1");
});

describe("fetchUrlAsText — body size limit", () => {
  it("succeeds when body is exactly at the cap", async () => {
    // Use a tiny cap so the test isn't slow.
    vi.stubEnv("TAPROOT_FETCH_MAX_BYTES", "10");
    // 10 bytes exactly — should succeed.
    mockFetch(makeResponse("0123456789", "text/plain"));
    const result = await fetchUrlAsText("http://localhost/test");
    expect(result.body).toBe("0123456789");
  });

  it("throws when body exceeds the cap by 1 byte", async () => {
    vi.stubEnv("TAPROOT_FETCH_MAX_BYTES", "10");
    // 11 bytes — should throw.
    mockFetch(makeResponse("01234567890", "text/plain"));
    await expect(fetchUrlAsText("http://localhost/test")).rejects.toThrow(
      /exceeded 10 bytes/,
    );
  });

  it("throws when body is far over the cap", async () => {
    vi.stubEnv("TAPROOT_FETCH_MAX_BYTES", "10");
    mockFetch(makeResponse("x".repeat(1000), "text/plain"));
    await expect(fetchUrlAsText("http://localhost/test")).rejects.toThrow(
      /exceeded 10 bytes/,
    );
  });

  it("falls back to .text() + byte-count check when response.body is null", async () => {
    vi.stubEnv("TAPROOT_FETCH_MAX_BYTES", "10");
    // 11 bytes, no stream.
    mockFetch(makeResponse("01234567890", "text/plain", false));
    await expect(fetchUrlAsText("http://localhost/test")).rejects.toThrow(
      /exceeded 10 bytes/,
    );
  });

  it("succeeds below the no-stream cap", async () => {
    vi.stubEnv("TAPROOT_FETCH_MAX_BYTES", "10");
    mockFetch(makeResponse("short", "text/plain", false));
    const result = await fetchUrlAsText("http://localhost/test");
    expect(result.body).toBe("short");
  });

  it("uses 10 MB default when TAPROOT_FETCH_MAX_BYTES is unset", async () => {
    // Just verify a small payload gets through without error.
    mockFetch(makeResponse("hello world", "text/plain"));
    const result = await fetchUrlAsText("http://localhost/test");
    expect(result.body).toBe("hello world");
  });
});
