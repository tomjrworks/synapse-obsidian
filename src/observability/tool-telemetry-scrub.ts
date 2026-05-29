// Defense-in-depth scrubber for telemetry events. Per-tool argsShape
// extractors in src/tools/*.ts should never emit vault content in the
// first place — every field they produce is documented in SPEC §5 as
// cardinality (ints, bools, coarse enums, count buckets) or hostname-only.
// This scrub catches refactor regressions: if someone accidentally
// reintroduces a leaky field name (e.g. `path`, `content`, `query`), it
// is replaced with [REDACTED] before the event is inserted.
//
// The constant list mirrors src/observability/sentry.ts:VAULT_FIELDS_TO_STRIP
// — keeping them aligned manually is intentional (Pass 1 doesn't want a
// runtime import dependency between observability modules; both lists are
// small and changes are rare).

const VAULT_FIELDS_TO_STRIP = new Set([
  "file_content",
  "content",
  "body",
  "frontmatter",
  "vault_path",
  "path",
  "file_path",
  "query",
  "search_query",
  "keywords",
  "results",
  "candidates",
  "remembered_text",
  "title",
  "url",
  "email",
]);

function scrubValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v));
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (VAULT_FIELDS_TO_STRIP.has(k.toLowerCase())) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = scrubValue(v);
    }
  }
  return out;
}

/**
 * Walk every leaf of the event and replace any field whose key is in the
 * vault-fields strip-list with the sentinel string "[REDACTED]". The
 * top-level columns (tool, kind, effect, workspace_id, tool_call_id) are
 * NEVER scrubbed — they're cardinality fields the wrapper controls. Only
 * the nested args_shape / outcome / branch_flags jsonb columns are walked.
 */
export function scrubTelemetryEvent<E>(event: E): E {
  const out = { ...(event as Record<string, unknown>) };
  if (out.args_shape && typeof out.args_shape === "object") {
    out.args_shape = scrubValue(out.args_shape);
  }
  if (out.outcome && typeof out.outcome === "object") {
    out.outcome = scrubValue(out.outcome);
  }
  if (out.branch_flags && typeof out.branch_flags === "object") {
    out.branch_flags = scrubValue(out.branch_flags);
  }
  return out as E;
}
