// ─────────────────────────────────────────────────────────────────────────
// Shared tool-gate helper. A behavior-gated tool stays REGISTERED in the
// manifest but short-circuits to this inert response when its flag is off
// (the pattern Pass 4 established for garden primitives and Pass 5 extends to
// the KB pipeline). Extracted here so garden-primitives / knowledge / init all
// emit the identical disabled response instead of carrying copies.
// ─────────────────────────────────────────────────────────────────────────

/** Inert flag-OFF response: no index read / no write, short text. */
export function disabledResponse(tool: string): {
  content: [{ type: "text"; text: string }];
} {
  return {
    content: [
      {
        type: "text" as const,
        text: `${tool} is not enabled for this workspace.`,
      },
    ],
  };
}
