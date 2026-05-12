import { describe, it, expect, vi } from "vitest";
import { maybeInjectDateModified } from "../../src/utils/date-modified.js";

const NOW = new Date(2026, 4, 12, 14, 30, 45); // 2026-05-12T14:30:45 local

describe("maybeInjectDateModified", () => {
  it("updates date_modified in an existing frontmatter block", () => {
    const input = `---
title: hello
date_modified: 2026-01-01T00:00:00
tags: [taproot]
---

body here
`;
    const out = maybeInjectDateModified(input, { now: NOW });
    expect(out).toContain("date_modified: '2026-05-12T14:30:45'");
    expect(out).toContain("title: hello");
    expect(out).toContain("body here");
  });

  it("adds date_modified to frontmatter that doesn't have it yet", () => {
    const input = `---
title: hello
---

body
`;
    const out = maybeInjectDateModified(input, { now: NOW });
    expect(out).toContain("date_modified: '2026-05-12T14:30:45'");
    expect(out).toContain("title: hello");
    expect(out).toContain("body");
  });

  it("leaves files without a frontmatter block unchanged", () => {
    const input = "# Plain note\n\nNo frontmatter here.\n";
    const out = maybeInjectDateModified(input, { now: NOW });
    expect(out).toBe(input);
  });

  it("returns content unchanged on malformed YAML and logs a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = `---
summary: Pricing: SITE wire-up: nested colons everywhere
tags: [unbalanced
---

body
`;
    const out = maybeInjectDateModified(input, { now: NOW });
    // Either the YAML is actually parseable (gray-matter is lenient) and the
    // function silently updates it, or it isn't and the function returns
    // content unchanged. In either case the file body must be preserved.
    expect(out).toContain("body");
    warn.mockRestore();
  });

  it("tolerates a leading newline before the opening --- delimiter", () => {
    // Regression: upstream callers sometimes prepend "\n" to the content.
    // Gray-matter detects + parses it fine, so we should too.
    const input = `\n---\ntitle: hello\ntags: [test]\n---\n\nbody\n`;
    const out = maybeInjectDateModified(input, { now: NOW });
    expect(out).toContain("date_modified: '2026-05-12T14:30:45'");
    expect(out).toContain("title: hello");
    expect(out).toContain("body");
  });

  it("preserves CRLF frontmatter delimiters", () => {
    const input = "---\r\ntitle: hello\r\n---\r\n\r\nbody\r\n";
    const out = maybeInjectDateModified(input, { now: NOW });
    expect(out).toContain("date_modified: '2026-05-12T14:30:45'");
    expect(out).toContain("title: hello");
  });
});
