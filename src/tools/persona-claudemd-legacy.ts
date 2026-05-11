/**
 * ROLLBACK ONLY — delete in 0.2.1.
 *
 * Preserves the prior trait-template composition so TAPROOT_TRAITS_ENABLED=1
 * keeps emitting Founder/Life-OS/Student/etc. sections for one release
 * window. Not called by the wizard. New users land with `traits: []`, which
 * degrades to universal scaffolding only — acceptable rollback shape.
 *
 * Do not extend this file. Bug fixes only. Removal task tracked in vault:
 *   projects/taproot/build/<date>-delete-trait-rollback-gate.md
 */

type LegacyTraitId =
  | "founder"
  | "writer-researcher"
  | "creator-designer"
  | "salesperson"
  | "student"
  | "life-os"
  | "professional-services";

const ALL: LegacyTraitId[] = [
  "founder",
  "writer-researcher",
  "creator-designer",
  "salesperson",
  "student",
  "life-os",
  "professional-services",
];

function isLegacyTrait(s: string): s is LegacyTraitId {
  return (ALL as string[]).includes(s);
}

const SECTION_MARKER_START = (id: string) =>
  `<!-- TAPROOT-MANAGED:${id} START -->`;
const SECTION_MARKER_END = (id: string) => `<!-- TAPROOT-MANAGED:${id} END -->`;

const TRAIT_SECTIONS: Record<LegacyTraitId, string> = {
  founder: `## Founder

You're building a company. Notes serve product decisions, customer development, investor relations, and team operations.`,
  "writer-researcher": `## Writer-Researcher

You write for a living — long-form pieces, research-heavy work, or both.`,
  "creator-designer": `## Creator-Designer

You make things — visual, written, or built.`,
  salesperson: `## Salesperson

You manage a pipeline. Notes serve account intelligence and deal progression.`,
  student: `## Student

You're in a degree program. Notes serve coursework and the long-term accumulation of a learned discipline.`,
  "life-os": `## Life-OS

You're using Taproot for personal organization — journaling, goals, reading, relationships, reflections.`,
  "professional-services": `## Professional Services

You run a service business — consulting, agency, freelance, advisory.`,
};

const LEGACY_PREAMBLE = `# CLAUDE.md

## What this vault is

This is your memory layer. The AI reads it, writes to it, and keeps it organized.

## Vault folders

- \`daily/\` — session logs.
- \`decisions/\` — dated decisions.
- \`projects/\` — active work.
- \`inbox/\` — fallback when no folder fits.`;

const LEGACY_CONVENTIONS = `## Conventions (universal)

- Filenames: lowercase-kebab-case.
- Date format: YYYY-MM-DD.
- Keep notes atomic.`;

/**
 * Emit the legacy trait-shaped CLAUDE.md for rollback. Marker-wrapped so
 * the merge path still locates the managed blocks.
 */
export function composeLegacyTraitSections(opts: {
  traits: string[];
  today?: string;
}): string {
  const today = opts.today ?? new Date().toISOString().split("T")[0];
  const seen = new Set<string>();
  const ordered: LegacyTraitId[] = [];
  for (const t of opts.traits) {
    if (!isLegacyTrait(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    ordered.push(t);
  }

  const filing = `${LEGACY_PREAMBLE}\n\n> Created ${today} | rollback path`;
  const traitsBody =
    ordered.length === 0
      ? "<!-- no legacy traits selected (rollback path) -->"
      : ordered.map((t) => TRAIT_SECTIONS[t]).join("\n\n");
  const conventions = LEGACY_CONVENTIONS;

  return (
    [
      [
        SECTION_MARKER_START("filing"),
        filing,
        SECTION_MARKER_END("filing"),
      ].join("\n"),
      [
        SECTION_MARKER_START("traits"),
        traitsBody,
        SECTION_MARKER_END("traits"),
      ].join("\n"),
      [
        SECTION_MARKER_START("conventions"),
        conventions,
        SECTION_MARKER_END("conventions"),
      ].join("\n"),
    ].join("\n\n") + "\n"
  );
}
