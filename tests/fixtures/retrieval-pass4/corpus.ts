// ─────────────────────────────────────────────────────────────────────────
// Pass 4a primitives fixture (EVALS 2026-06-04-pass-4-primitives-evals §0 +
// PLAN 2026-06-04-pass-4a-plan §4). PASS4_CORPUS = the FROZEN Pass 3 corpus
// spread + the ONE genuinely-new note 4a needs:
//
//   daily/2026-05/2026-05-26-is7012-new-course.md — the IDN1 collision foil.
//   A PRESENT note carrying the identifier `is7012` (shares the `is` letter-run
//   with `is7011`). Two jobs:
//     1. IDN1 anti-gold: garden_identifier("is7011") derives targets {is7011,
//        7011}; this note's token set contains NEITHER (it never writes "7011"),
//        so a correct sub-token matcher must NOT return it — the run-collision
//        precision test.
//     2. IDN4 related-id: garden_identifier("is7013") (truly absent) suggests
//        the present `is7011` AND `is7012` via the shared `is` run.
//
// CRITICAL: this note's body must never contain the substring "7011" — that
// would tokenize to `7011` and leak the foil into the IDN1 result set, breaking
// precision=1.0. It references only IS 7012.
//
// Pass 3 corpus stays FROZEN (its bodies deliberately carry no wikilinks).
// 4a is read-only over the EXISTING index — no backlink/wikilink fixtures
// (that's Pass 4b). identifier neighbors (pr7/8/9, the is7011 modules + the
// is7011 case-writeup daily) already live in the Pass 3 corpus and are reused.
// ─────────────────────────────────────────────────────────────────────────

import { CORPUS } from "../retrieval-pass3/corpus.js";

const pass4Additions: Record<string, string> = {
  // IDN1 collision foil (present) + IDN4 related-id suggestion. References IS
  // 7012 ONLY — never "7011" — so target {is7011,7011} can't match it.
  "daily/2026-05/2026-05-26-is7012-new-course.md": [
    "---",
    "title: IS7012 new course kickoff",
    "type: handoff",
    "summary: Started the IS 7012 elective course",
    "---",
    "# IS7012 new course",
    "",
    "Kicked off the IS 7012 elective this term. Logged the syllabus and the",
    "first reading assignment for the new course.",
  ].join("\n"),
};

export const PASS4_CORPUS: Record<string, string> = {
  ...CORPUS,
  ...pass4Additions,
};
