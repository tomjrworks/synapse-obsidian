import { describe, it, expect } from "vitest";
import { mergeIntoExistingClaudeMd } from "../../src/tools/claudemd-merge.js";
import {
  SECTION_MARKER_END,
  SECTION_MARKER_START,
  type ManagedSections,
} from "../../src/tools/persona-claudemd.js";

const NEW: ManagedSections = {
  filing: "FILING-NEW-BODY",
  traits: "TRAITS-NEW-BODY",
  conventions: "CONVENTIONS-NEW-BODY",
};

function wrap(id: "filing" | "traits" | "conventions", body: string): string {
  return `${SECTION_MARKER_START(id)}\n${body}\n${SECTION_MARKER_END(id)}`;
}

describe("mergeIntoExistingClaudeMd", () => {
  it("(case 1) replaces all three sections in-place when all markers exist", () => {
    const existing = [
      wrap("filing", "FILING-OLD"),
      wrap("traits", "TRAITS-OLD"),
      wrap("conventions", "CONVENTIONS-OLD"),
    ].join("\n\n");

    const result = mergeIntoExistingClaudeMd(existing, NEW);

    expect(result.merged).toContain("FILING-NEW-BODY");
    expect(result.merged).toContain("TRAITS-NEW-BODY");
    expect(result.merged).toContain("CONVENTIONS-NEW-BODY");
    expect(result.merged).not.toContain("FILING-OLD");
    expect(result.merged).not.toContain("TRAITS-OLD");
    expect(result.merged).not.toContain("CONVENTIONS-OLD");
    expect(result.replaced).toEqual(["filing", "traits", "conventions"]);
    expect(result.appended).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("(case 2) preserves user content OUTSIDE markers verbatim", () => {
    const userExtras = [
      "## My personal notes",
      "Some hand-written prose the user added.",
      "",
      "[[my-link]] should survive.",
    ].join("\n");
    const existing = [
      wrap("filing", "FILING-OLD"),
      "",
      userExtras,
      "",
      wrap("traits", "TRAITS-OLD"),
      wrap("conventions", "CONVENTIONS-OLD"),
    ].join("\n");

    const result = mergeIntoExistingClaudeMd(existing, NEW);

    expect(result.merged).toContain("My personal notes");
    expect(result.merged).toContain("Some hand-written prose");
    expect(result.merged).toContain("[[my-link]] should survive.");
  });

  it("(case 3) appends a missing section at the end with fresh markers", () => {
    // Only filing markers present; traits + conventions missing
    const existing = wrap("filing", "FILING-OLD") + "\n";

    const result = mergeIntoExistingClaudeMd(existing, NEW);

    expect(result.merged).toContain("FILING-NEW-BODY");
    expect(result.merged).toContain(SECTION_MARKER_START("traits"));
    expect(result.merged).toContain(SECTION_MARKER_END("traits"));
    expect(result.merged).toContain("TRAITS-NEW-BODY");
    expect(result.merged).toContain("CONVENTIONS-NEW-BODY");
    expect(result.replaced).toEqual(["filing"]);
    expect(result.appended).toEqual(["traits", "conventions"]);
    // No warnings — missing markers are normal first-edit territory
    expect(result.warnings).toEqual([]);
  });

  it("(case 4) appends with a warning when only START exists (orphan START)", () => {
    const existing = `${SECTION_MARKER_START("filing")}\nFILING-OLD\n(no end marker — user deleted it)`;

    const result = mergeIntoExistingClaudeMd(existing, NEW);

    expect(result.replaced).toEqual([]);
    expect(result.appended).toContain("filing");
    expect(
      result.warnings.some(
        (w) => w.includes('"filing"') && w.includes("START"),
      ),
    ).toBe(true);
    // Original content preserved
    expect(result.merged).toContain("FILING-OLD");
  });

  it("(case 5) appends with a warning when only END exists (orphan END)", () => {
    const existing = `Some prose\n${SECTION_MARKER_END("traits")}\nMore prose`;

    const result = mergeIntoExistingClaudeMd(existing, NEW);

    expect(
      result.warnings.some((w) => w.includes('"traits"') && w.includes("END")),
    ).toBe(true);
    expect(result.appended).toContain("traits");
    expect(result.merged).toContain("Some prose");
    expect(result.merged).toContain("More prose");
  });

  it("(case 6) handles END-before-START as malformed (single-section variant)", () => {
    // END appears before START for the same id
    const existing = `${SECTION_MARKER_END("filing")}\nstuff\n${SECTION_MARKER_START("filing")}\nFILING-OLD`;

    const result = mergeIntoExistingClaudeMd(existing, NEW);

    // Locator finds START at position p, then searches forward for END — won't find one,
    // so this falls into the "orphan START" diagnostic path (because there IS an END
    // somewhere, just not after the START it found). Either way: appended with a warning.
    expect(result.replaced).not.toContain("filing");
    expect(result.appended).toContain("filing");
    expect(result.warnings.some((w) => w.includes('"filing"'))).toBe(true);
  });

  it("(case 7) replaced sections keep their original markers (idempotent across re-runs)", () => {
    const existing = [
      wrap("filing", "FILING-OLD"),
      wrap("traits", "TRAITS-OLD"),
      wrap("conventions", "CONVENTIONS-OLD"),
    ].join("\n\n");

    const first = mergeIntoExistingClaudeMd(existing, NEW);
    const second = mergeIntoExistingClaudeMd(first.merged, NEW);

    expect(second.merged).toBe(first.merged);
    expect(second.replaced).toEqual(["filing", "traits", "conventions"]);
    expect(second.appended).toEqual([]);
    expect(second.warnings).toEqual([]);
  });

  it("(case 8) starting from an empty/no-marker doc, all three sections are appended", () => {
    const existing = "# CLAUDE.md\n\nUser wrote this whole file by hand.\n";

    const result = mergeIntoExistingClaudeMd(existing, NEW);

    expect(result.replaced).toEqual([]);
    expect(result.appended).toEqual(["filing", "traits", "conventions"]);
    // User's hand-written content preserved at the top
    expect(result.merged).toContain("User wrote this whole file by hand.");
    // All three sections present at the end with fresh markers
    expect(result.merged).toContain(SECTION_MARKER_START("filing"));
    expect(result.merged).toContain(SECTION_MARKER_START("traits"));
    expect(result.merged).toContain(SECTION_MARKER_START("conventions"));
    expect(result.merged).toContain("FILING-NEW-BODY");
    expect(result.merged).toContain("TRAITS-NEW-BODY");
    expect(result.merged).toContain("CONVENTIONS-NEW-BODY");
  });
});
