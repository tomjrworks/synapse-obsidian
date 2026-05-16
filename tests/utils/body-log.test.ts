import { describe, it, expect } from "vitest";
import {
  formatRequestBody,
  BODY_LOG_SKIP_PATHS,
  SENSITIVE_BODY_KEYS,
} from "../../src/utils/body-log.js";

describe("formatRequestBody", () => {
  it("skips /mcp bodies entirely (H-C)", () => {
    expect(BODY_LOG_SKIP_PATHS.has("/mcp")).toBe(true);
    expect(
      formatRequestBody("/mcp", { params: { content: "private note body" } }),
    ).toBe("[skipped]");
  });

  it("keeps skipping the pre-existing content routes", () => {
    expect(formatRequestBody("/api/sync/push", { files: [] })).toBe(
      "[skipped]",
    );
    expect(formatRequestBody("/api/first-wow", { text: "x" })).toBe(
      "[skipped]",
    );
  });

  it("redacts user-content fields on non-skip routes (M3)", () => {
    const out = formatRequestBody("/api/feedback", {
      message: "secret journal entry",
      content: "more private text",
      email: "user@example.com",
    });
    expect(out).not.toContain("secret journal entry");
    expect(out).not.toContain("more private text");
    expect(out).not.toContain("user@example.com");
    expect(out).toContain("[redacted]");
  });

  it("redacts nested content fields at any depth", () => {
    const out = formatRequestBody("/api/persona/render", {
      payload: { note: "deep private content" },
    });
    expect(out).not.toContain("deep private content");
    expect(out).toContain("[redacted]");
  });

  it("logs non-sensitive fields normally and caps at 300 chars", () => {
    const out = formatRequestBody("/api/whatever", { interval: "month" });
    expect(out).toContain("month");
    const long = formatRequestBody("/api/whatever", { x: "z".repeat(500) });
    expect(long.length).toBe(300);
  });

  it("returns empty string for a falsy body", () => {
    expect(formatRequestBody("/api/whatever", undefined)).toBe("");
  });

  it("covers the new content keys", () => {
    for (const key of [
      "content",
      "text",
      "query",
      "message",
      "note",
      "body",
      "edits",
      "remembered_text",
    ]) {
      expect(SENSITIVE_BODY_KEYS.has(key)).toBe(true);
    }
  });
});
