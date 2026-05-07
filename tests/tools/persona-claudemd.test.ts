import { describe, it, expect } from "vitest";
import {
  composePersonaClaudeMd,
  composePersonaSections,
  MANAGED_SECTION_ORDER,
  SECTION_MARKER_END,
  SECTION_MARKER_START,
} from "../../src/tools/persona-claudemd.js";

describe("persona-claudemd HTML markers + WRITE_AUTOMATICALLY restore", () => {
  it("wraps every managed section in TAPROOT-MANAGED START/END markers", () => {
    const out = composePersonaClaudeMd({ traits: ["builder"] });
    for (const id of MANAGED_SECTION_ORDER) {
      expect(out).toContain(SECTION_MARKER_START(id));
      expect(out).toContain(SECTION_MARKER_END(id));
      // START must precede END
      expect(out.indexOf(SECTION_MARKER_START(id))).toBeLessThan(
        out.indexOf(SECTION_MARKER_END(id)),
      );
    }
  });

  it("includes the restored Write AUTOMATICALLY section in the persona output", () => {
    const out = composePersonaClaudeMd({ traits: ["builder"] });
    expect(out).toContain("Write AUTOMATICALLY");
    expect(out).toContain("don't wait to be asked");
    expect(out).toContain("Session logs");
  });

  it("emits sections in MANAGED_SECTION_ORDER (filing → traits → conventions)", () => {
    const out = composePersonaClaudeMd({ traits: ["builder"] });
    const filingIdx = out.indexOf(SECTION_MARKER_START("filing"));
    const traitsIdx = out.indexOf(SECTION_MARKER_START("traits"));
    const conventionsIdx = out.indexOf(SECTION_MARKER_START("conventions"));
    expect(filingIdx).toBeGreaterThan(-1);
    expect(traitsIdx).toBeGreaterThan(filingIdx);
    expect(conventionsIdx).toBeGreaterThan(traitsIdx);
  });

  it("composePersonaSections returns the 3 section bodies without markers", () => {
    const sections = composePersonaSections({
      traits: ["builder"],
      today: "2026-05-07",
    });
    expect(sections.filing).toContain("# CLAUDE.md");
    expect(sections.filing).toContain("Created 2026-05-07");
    expect(sections.filing).toContain("Write AUTOMATICALLY");
    expect(sections.traits.length).toBeGreaterThan(0);
    expect(sections.conventions).toContain("Conventions (universal)");
    // Section bodies should NOT carry markers themselves
    expect(sections.filing).not.toContain("TAPROOT-MANAGED");
    expect(sections.traits).not.toContain("TAPROOT-MANAGED");
    expect(sections.conventions).not.toContain("TAPROOT-MANAGED");
  });

  it("renders an empty-traits placeholder when no traits selected (still wraps in markers)", () => {
    const out = composePersonaClaudeMd({ traits: [] });
    expect(out).toContain(SECTION_MARKER_START("traits"));
    expect(out).toContain(SECTION_MARKER_END("traits"));
    expect(out).toContain("no persona traits selected");
  });
});
