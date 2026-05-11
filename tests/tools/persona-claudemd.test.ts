import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  classifyClaudeMdContent,
  composePersonaClaudeMd,
  composePersonaSections,
  MANAGED_SECTION_ORDER,
  SECTION_MARKER_END,
  SECTION_MARKER_START,
  _internal,
} from "../../src/tools/persona-claudemd.js";

describe("composePersonaClaudeMd — marker contract", () => {
  it("wraps every managed section in TAPROOT-MANAGED START/END markers", () => {
    const out = composePersonaClaudeMd({});
    for (const id of MANAGED_SECTION_ORDER) {
      expect(out).toContain(SECTION_MARKER_START(id));
      expect(out).toContain(SECTION_MARKER_END(id));
      expect(out.indexOf(SECTION_MARKER_START(id))).toBeLessThan(
        out.indexOf(SECTION_MARKER_END(id)),
      );
    }
  });

  it("emits sections in MANAGED_SECTION_ORDER (filing → traits → conventions)", () => {
    const out = composePersonaClaudeMd({});
    const f = out.indexOf(SECTION_MARKER_START("filing"));
    const t = out.indexOf(SECTION_MARKER_START("traits"));
    const c = out.indexOf(SECTION_MARKER_START("conventions"));
    expect(f).toBeGreaterThan(-1);
    expect(t).toBeGreaterThan(f);
    expect(c).toBeGreaterThan(t);
  });

  it("composePersonaSections returns section bodies without markers", () => {
    const sections = composePersonaSections({ today: "2026-05-11" });
    expect(sections.filing).toContain("# CLAUDE.md");
    expect(sections.filing).toContain("Created 2026-05-11");
    expect(sections.filing).toContain("Write AUTOMATICALLY");
    expect(sections.traits).toContain("Learned filing rules");
    expect(sections.conventions).toContain("Conventions (universal)");
    expect(sections.filing).not.toContain("TAPROOT-MANAGED");
    expect(sections.traits).not.toContain("TAPROOT-MANAGED");
    expect(sections.conventions).not.toContain("TAPROOT-MANAGED");
  });
});

describe("composePersonaSections — folder scan rendering", () => {
  it("emits the L7 starter scaffold when folder scan is empty", () => {
    const out = composePersonaSections({ folderScan: [] });
    for (const folder of ["daily", "decisions", "inbox", "notes", "projects"]) {
      expect(out.filing).toContain(`\`${folder}/\``);
    }
    expect(out.filing).toContain("Starter folders");
  });

  it("emits only the observed folders when folder scan is non-empty", () => {
    const out = composePersonaSections({
      folderScan: [
        { name: "daily", summary: "session logs" },
        { name: "projects", summary: "active work" },
      ],
    });
    expect(out.filing).toContain("`daily/` — session logs");
    expect(out.filing).toContain("`projects/` — active work");
    // No starter-scaffold leakage when real folders are present
    expect(out.filing).not.toContain("Starter folders");
    expect(out.filing).not.toContain("`inbox/` — landing pad");
  });

  it("Tom-shaped vault (14 folders) renders all 14 by name", () => {
    const toms = [
      "app-building",
      "cooking",
      "daily",
      "decisions",
      "ideas",
      "inbox",
      "meetings",
      "notes",
      "projects",
      "references",
      "research",
      "school",
      "sources",
      "templates",
    ].map((n) => ({ name: n, summary: `${n} notes` }));
    const out = composePersonaSections({ folderScan: toms });
    for (const f of toms) {
      expect(out.filing).toContain(`\`${f.name}/\``);
    }
    // Fictional trait-template folders must NOT appear
    for (const fake of [
      "metrics",
      "playbook",
      "journal",
      "goals",
      "habits",
      "books",
      "people",
      "reflections",
      "courses",
      "assignments",
      "exams",
      "papers",
      "concepts",
    ]) {
      expect(out.filing).not.toContain(`\`${fake}/\``);
    }
  });
});

describe("composePersonaSections — L8 guardrail", () => {
  it("filing block always contains all 5 numbered filing-decision-tree rules verbatim", () => {
    // Render under three different inputs to prove the tree is invariant.
    const renderings = [
      composePersonaSections({ folderScan: [] }).filing,
      composePersonaSections({
        folderScan: [{ name: "daily", summary: "x" }],
      }).filing,
      composePersonaSections({
        folderScan: Array.from({ length: 14 }, (_, i) => ({
          name: `f${i}`,
          summary: "x",
        })),
      }).filing,
    ];
    const rules = [
      "1. **Explicit user direction wins.**",
      "2. **Match a learned filing rule**",
      "3. **Top-level theme match, no subfolder.**",
      "4. **No clear home.**",
      "5. **NEVER create a new TOP-LEVEL folder silently.**",
    ];
    for (const render of renderings) {
      for (const rule of rules) {
        expect(render).toContain(rule);
      }
    }
  });
});

describe("composePersonaSections — learned rules block", () => {
  it("renders '(none yet)' when no learned rules", () => {
    const out = composePersonaSections({});
    expect(out.traits).toContain("(none yet)");
  });

  it("renders learned rules as bullets when provided", () => {
    const out = composePersonaSections({
      learnedRules: [
        "Save customer call notes to meetings/customers/",
        "Decisions get YYYY-MM-DD-<topic>.md naming",
      ],
    });
    expect(out.traits).toContain(
      "- Save customer call notes to meetings/customers/",
    );
    expect(out.traits).toContain(
      "- Decisions get YYYY-MM-DD-<topic>.md naming",
    );
    expect(out.traits).not.toContain("(none yet)");
  });
});

describe("classifyClaudeMdContent", () => {
  it("returns fresh for null content", () => {
    expect(classifyClaudeMdContent(null)).toBe("fresh");
  });

  it("returns fresh for content <=50 chars trimmed", () => {
    expect(classifyClaudeMdContent("   ")).toBe("fresh");
    expect(classifyClaudeMdContent("# My Vault")).toBe("fresh");
    expect(classifyClaudeMdContent("# Welcome\n")).toBe("fresh");
  });

  it("returns taproot_managed when any TAPROOT-MANAGED marker is present", () => {
    const content =
      "Some intro\n" +
      "<!-- TAPROOT-MANAGED:filing START -->\nfiling body\n<!-- TAPROOT-MANAGED:filing END -->\n";
    expect(classifyClaudeMdContent(content)).toBe("taproot_managed");
  });

  it("returns user_owned for substantive content with no markers", () => {
    const content =
      "# My CLAUDE.md\n\nThis is my hand-curated filing system. ".repeat(10);
    expect(classifyClaudeMdContent(content)).toBe("user_owned");
  });
});

describe("rollback gate — TAPROOT_TRAITS_ENABLED", () => {
  const originalEnv = process.env.TAPROOT_TRAITS_ENABLED;

  beforeEach(() => {
    delete process.env.TAPROOT_TRAITS_ENABLED;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.TAPROOT_TRAITS_ENABLED;
    else process.env.TAPROOT_TRAITS_ENABLED = originalEnv;
  });

  it("default (env unset) emits folder-scan output", () => {
    const out = composePersonaClaudeMd({
      folderScan: [{ name: "projects", summary: "active work" }],
    });
    expect(out).toContain("`projects/` — active work");
    expect(out).toContain("Learned filing rules");
  });

  it("TAPROOT_TRAITS_ENABLED=1 routes to legacy trait composer", () => {
    process.env.TAPROOT_TRAITS_ENABLED = "1";
    const out = composePersonaClaudeMd({ legacyTraits: ["founder"] });
    expect(out).toContain("## Founder");
    expect(out).toContain("rollback path");
    // Universal scaffolding constants from the new path should NOT appear
    expect(out).not.toContain("Learned filing rules");
  });

  it("rollback with empty legacyTraits degrades to universal-only", () => {
    process.env.TAPROOT_TRAITS_ENABLED = "1";
    const out = composePersonaClaudeMd({ legacyTraits: [] });
    expect(out).toContain("no legacy traits selected");
  });
});

describe("internal scaffolding constants", () => {
  it("STARTER_FOLDERS includes the 5 named starter folders", () => {
    const names = _internal.STARTER_FOLDERS.map((f) => f.name);
    expect(names).toEqual(["daily", "decisions", "inbox", "notes", "projects"]);
  });

  it("FRESH_CHAR_FLOOR is 50", () => {
    expect(_internal.FRESH_CHAR_FLOOR).toBe(50);
  });
});
