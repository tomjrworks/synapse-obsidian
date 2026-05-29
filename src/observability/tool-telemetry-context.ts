// Per-tool-call telemetry context. The wrapper in tool-telemetry.ts mints
// one of these at handler entry and passes it to the handler body. Handlers
// mutate the fields they're responsible for (branch flags at known boundary
// lines, result_count + no_results before returning, errorCode in catch
// blocks) and the wrapper assembles them into a single emitted event.
//
// Field choices follow SPEC §2 + EVALS Part 2:
//   - flags: only ints/bools/short enums/cardinality buckets — never vault content
//   - resultCount: int — the count behind no_results, for downstream "thin result" analysis
//   - noResults: bool — single most important Pass 2 anchor
//   - errorCode: handler-supplied in the catch block so the wrapper knows the
//     canonical code without parsing respondToolError's text payload

export type FlagValue = boolean | number | string | null;

export interface TelemetryContext {
  toolCallId: string;
  flags: Record<string, FlagValue>;
  resultCount?: number;
  noResults?: boolean;
  errorCode?: string;
}
