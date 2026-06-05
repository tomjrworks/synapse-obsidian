// ─────────────────────────────────────────────────────────────────────────
// Pass 4b garden_backlinks fixture = FROZEN Pass 4a corpus + wikilink-dense
// additions (spec-of-record: 2026-06-04-pass-4-primitives-evals §1). The whole
// correctness story is FALSE EDGES: a [[wikilink]] is a real edge; a prose
// mention that merely tokenizes the same is NOT. Precision must be 1.000.
//
//   course-index.md       — links [[module-1…]] and [[module-2…]]      (plain)
//   module-3-it-strategy  — links [[module-1…|Module 1]] (alias) AND
//                           [[module-1…#Frameworks]]      (heading)
//   course-recap.md       — PROSE "module 1 it competitive advantage…" with
//                           NO [[…]]  ← the false-edge trap (must NOT return)
//   orphan-note.md        — nothing links to it          (BL5 honest-empty)
//
// The target note module-1-it-competitive-advantage.md already lives in the
// Pass 3 corpus with NO links of its own — a clean backlink target.
// ─────────────────────────────────────────────────────────────────────────

import { PASS4_CORPUS } from "../retrieval-pass4/corpus.js";

const backlinkAdditions: Record<string, string> = {
  "school/is-7011-it-management/course-index.md": [
    "---",
    "title: IS 7011 course index",
    "type: index",
    "---",
    "# IS 7011 course index",
    "",
    "- [[module-1-it-competitive-advantage]]",
    "- [[module-2-data-governance]]",
  ].join("\n"),
  "school/is-7011-it-management/module-3-it-strategy.md": [
    "---",
    "title: IS 7011 Module 3 — IT Strategy",
    "type: course-note",
    "---",
    "# IT strategy",
    "",
    "Builds on [[module-1-it-competitive-advantage|Module 1]] and revisits the",
    "[[module-1-it-competitive-advantage#Frameworks]] section in depth.",
  ].join("\n"),
  "daily/2026-06/2026-06-05-course-recap.md": [
    "---",
    "title: Course recap",
    "type: handoff",
    "---",
    "# Recap",
    "",
    "Reviewed the course. Module 1 it competitive advantage was about value",
    "chains and the resource based view. This is prose — there is no link here.",
  ].join("\n"),
  "notes/orphan-note.md": [
    "---",
    "title: Orphan note",
    "type: note",
    "---",
    "# Orphan",
    "",
    "Nothing in the vault links to this note.",
  ].join("\n"),
};

export const PASS4B_BACKLINKS_CORPUS: Record<string, string> = {
  ...PASS4_CORPUS,
  ...backlinkAdditions,
};

// Handles (so bars never hard-code path strings).
export const TARGET_M1 =
  "school/is-7011-it-management/module-1-it-competitive-advantage.md";
export const TARGET_M1_BASENAME = "module-1-it-competitive-advantage";
export const COURSE_INDEX = "school/is-7011-it-management/course-index.md";
export const MODULE3 = "school/is-7011-it-management/module-3-it-strategy.md";
export const RECAP = "daily/2026-06/2026-06-05-course-recap.md";
export const ORPHAN = "notes/orphan-note.md";
