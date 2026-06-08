// ─────────────────────────────────────────────────────────────────────────
// Pass 5 — KB-pipeline behavior gate (decision 2026-06-06-pass-5-direction,
// fork 3). The legacy seed/water/cultivate/sow pipeline is removed from the
// DEFAULT surface the way this codebase has always done it: a behavior gate,
// not a manifest removal (1:1 with the Pass-4 garden-primitives pattern,
// garden-primitives.ts:45-56). Tools stay registered; handlers short-circuit to
// a disabled response when the flag is off.
//
// Default OFF. Mirrors GARDEN_PLANT_DATE_INJECT / TAPROOT_GARDEN_* exactly:
// the literal string "1" enables; everything else (unset, "0", "true", "") is OFF.
// ─────────────────────────────────────────────────────────────────────────
export function kbPipelineEnabled(): boolean {
  return process.env.TAPROOT_KB_PIPELINE === "1";
}
