import { describe, it, expect, vi } from "vitest";
import { withRetry, isTransient } from "../../src/utils/retry.js";

describe("isTransient", () => {
  it("recognizes transient HTTP status codes", () => {
    expect(isTransient({ status: 429 })).toBe(true);
    expect(isTransient({ status: 500 })).toBe(true);
    expect(isTransient({ status: 502 })).toBe(true);
    expect(isTransient({ status: 503 })).toBe(true);
    expect(isTransient({ status: 504 })).toBe(true);
    expect(isTransient({ statusCode: "503" })).toBe(true);
  });

  it("rejects non-transient HTTP status codes", () => {
    expect(isTransient({ status: 400 })).toBe(false);
    expect(isTransient({ status: 401 })).toBe(false);
    expect(isTransient({ status: 404 })).toBe(false);
    expect(isTransient({ status: 409 })).toBe(false);
  });

  it("recognizes transient network error codes", () => {
    expect(isTransient({ code: "ECONNRESET" })).toBe(true);
    expect(isTransient({ code: "ETIMEDOUT" })).toBe(true);
    expect(isTransient({ code: "EAI_AGAIN" })).toBe(true);
    expect(isTransient({ code: "ENETUNREACH" })).toBe(true);
    expect(isTransient({ code: "ECONNREFUSED" })).toBe(true);
  });

  it("recognizes fetch TypeError as transient", () => {
    const e = new TypeError("fetch failed");
    expect(isTransient(e)).toBe(true);
  });

  it("rejects null / undefined / non-object", () => {
    expect(isTransient(null)).toBe(false);
    expect(isTransient(undefined)).toBe(false);
    expect(isTransient("oops")).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns success on first attempt without retry", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on transient error and eventually succeeds", async () => {
    const transient = Object.assign(new Error("rate limited"), { status: 429 });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce("ok");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await withRetry(fn, { attempts: 3, baseMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    warnSpy.mockRestore();
  });

  it("does not retry on non-transient error", async () => {
    const nonTransient = Object.assign(new Error("bad request"), {
      status: 400,
    });
    const fn = vi.fn().mockRejectedValue(nonTransient);
    await expect(withRetry(fn, { attempts: 3, baseMs: 1 })).rejects.toBe(
      nonTransient,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("exhausts attempts and re-throws last transient error", async () => {
    const transient = Object.assign(new Error("still failing"), {
      status: 503,
    });
    const fn = vi.fn().mockRejectedValue(transient);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(withRetry(fn, { attempts: 3, baseMs: 1 })).rejects.toBe(
      transient,
    );
    expect(fn).toHaveBeenCalledTimes(3);
    warnSpy.mockRestore();
  });

  it("floors delay at Retry-After header value when present and within cap", async () => {
    const err = Object.assign(new Error("rate limited"), {
      status: 429,
      headers: { "retry-after": "2" }, // 2 seconds
    });
    let capturedWaitMs = 0;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const setTimeoutSpy = vi
      .spyOn(global, "setTimeout")
      .mockImplementation((fn: TimerHandler, ms?: number) => {
        capturedWaitMs = ms as number;
        (fn as () => void)();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });
    await expect(
      withRetry(() => Promise.reject(err), { attempts: 2, baseMs: 10 }),
    ).rejects.toThrow();
    expect(capturedWaitMs).toBeGreaterThanOrEqual(2_000);
    warnSpy.mockRestore();
    setTimeoutSpy.mockRestore();
  });
});
