import { supabaseService } from "../api/supabase.js";
import { scrubTelemetryEvent } from "../observability/tool-telemetry-scrub.js";

// Telemetry write path. Fire-and-forget single-row insert into
// tool_call_events (migration 0029). Insert failures NEVER propagate to
// the caller — diagnostic data loss on crash is acceptable per SPEC §4.
//
// Sync insert would add ~10-50ms per tool call (PostgREST round-trip),
// burning a Pass 7 perf trigger on Pass 1 overhead. Bulk batching is a
// Pass 7 optimization if/when row rate climbs past the 100k/day threshold
// in amendment A4.

export interface TelemetryEventRow {
  tool_call_id: string;
  tool: string;
  kind: "read" | "write";
  effect: "read" | "write" | "instruction-only";
  workspace_id: string | null;
  args_shape: Record<string, unknown> | null;
  outcome: Record<string, unknown>;
  branch_flags: Record<string, unknown> | null;
  schema_version: number;
}

/**
 * Best-effort insert. Returns immediately; the network round-trip is not
 * awaited by the caller. On insert failure, logs to stderr with a
 * [telemetry] prefix (no Discord 5xx ping — see deploy gate 10).
 *
 * Service-role bypass via supabaseService() is required: the table has
 * RLS enabled with no permissive policies (matches 0027 +
 * workspace_subscriptions).
 */
export function emitTelemetryEvent(event: TelemetryEventRow): void {
  if (process.env.TAPROOT_TOOL_TELEMETRY === "0") return;

  let scrubbed: TelemetryEventRow;
  try {
    scrubbed = scrubTelemetryEvent(event);
  } catch (scrubErr) {
    console.error(`[telemetry] scrub failed: ${scrubErr}`);
    return;
  }

  let client;
  try {
    client = supabaseService();
  } catch (clientErr) {
    // SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — in dev/test this
    // is expected. Don't log noisily.
    if (process.env.NODE_ENV === "production") {
      console.error(`[telemetry] supabase client unavailable: ${clientErr}`);
    }
    return;
  }

  void client
    .from("tool_call_events")
    .insert(scrubbed)
    .then(({ error }) => {
      if (error) {
        console.error(`[telemetry] insert failed: ${error.message}`);
      }
    });
}
