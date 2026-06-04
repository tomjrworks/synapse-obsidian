// ─────────────────────────────────────────────────────────────────────────
// Pass 4b cluster fixture = the FROZEN Pass 4a corpus + cluster-over-merge
// foils that the Pass 4a fixture deliberately lacks. The real vault (1479
// notes) showed garden_cluster's family-run signal collapses on GENERIC
// shared runs — the year `2026` alone bonded 1009 notes, and every 2-digit
// calendar/count number bonded hundreds. The Pass 4a corpus is too small to
// exhibit that (its dates live in filenames, which clusterIdRuns ignores).
//
// These foils reproduce the failure in miniature: three topically-DISJOINT
// notes whose ONLY shared identifier signal is a calendar run (the date
// 2026-05-30 in their bodies → runs 2026 / 05 / 30). Under the un-gated
// clusterRelated they merge into one false cluster; a correct family signal
// must leave them as singletons (dropped from the unseeded output).
//
// CRITICAL: the three foils share NO topical vocabulary (sourdough vs.
// marathon vs. film) so content-Jaccard can't bind them — the ONLY thing
// that can is the calendar run. That isolates the gate under test.
// ─────────────────────────────────────────────────────────────────────────

import { PASS4_CORPUS } from "../retrieval-pass4/corpus.js";

const clusterFoils: Record<string, string> = {
  "notes/recipe-sourdough-loaf.md": [
    "---",
    "title: Sourdough loaf recipe",
    "type: recipe",
    "---",
    "# Sourdough loaf",
    "",
    "Updated 2026-05-30. Feed the starter, autolyse the flour and water,",
    "bulk ferment, shape the boule, proof overnight, bake in a dutch oven.",
  ].join("\n"),
  "notes/marathon-training-log.md": [
    "---",
    "title: Marathon training log",
    "type: log",
    "---",
    "# Marathon training",
    "",
    "Updated 2026-05-30. Tempo run intervals, long slow distance on Sunday,",
    "tracking cadence and heart rate zones ahead of the October race.",
  ].join("\n"),
  "notes/film-review-dune.md": [
    "---",
    "title: Film review — Dune",
    "type: review",
    "---",
    "# Dune review",
    "",
    "Updated 2026-05-30. Villeneuve's desert cinematography and score carry",
    "the adaptation; the pacing of the political intrigue drags midway.",
  ].join("\n"),
};

export const PASS4B_CORPUS: Record<string, string> = {
  ...PASS4_CORPUS,
  ...clusterFoils,
};

// Exported handles for the eval (so the bars never hard-code path strings).
export const FOIL_RECIPE = "notes/recipe-sourdough-loaf.md";
export const FOIL_MARATHON = "notes/marathon-training-log.md";
export const FOIL_FILM = "notes/film-review-dune.md";
export const FOILS = [FOIL_RECIPE, FOIL_MARATHON, FOIL_FILM];
