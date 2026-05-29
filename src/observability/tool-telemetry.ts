import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  checkToolRateLimit,
  rateLimitToolError,
  type ToolKind,
} from "../tools/_rate-limit.js";
import {
  emitTelemetryEvent,
  type TelemetryEventRow,
} from "../utils/supabase-telemetry.js";
import type { TelemetryContext } from "./tool-telemetry-context.js";

export type { TelemetryContext, FlagValue } from "./tool-telemetry-context.js";

// Pass 1 observability wrapper. Replaces the boilerplate
//   checkToolRateLimit → try { work } catch { respondToolError }
// in all 22 MCP tool handlers with a single composable wrapper that
// also emits one telemetry event per call.
//
// Design contract: SPEC §2 + amendments A1/A2/A3/A6/A7/A8 in
// projects/taproot/build/2026-05-28-mcp-pass-1-plan-supplement.md §8.
//
// Behavior summary:
//   1. Mint a per-call tool_call_id (UUID v4) and a fresh ctx.
//   2. Check the rate-limit bucket. On deny, emit a rate_limited event
//      and return rateLimitToolError(...) WITHOUT invoking the handler.
//   3. Run handler(args, ctx) under performance.now() boundaries.
//   4. On success: read ctx.{noResults,resultCount,flags,errorCode} +
//      detect isError on the response, emit one event.
//   5. On throw: emit one event with ok=false, error_code from ctx or
//      "unknown", then re-throw to the existing /mcp outer catch.
//   6. Emit is fire-and-forget — emit failures never propagate.
//   7. Kill switch TAPROOT_TOOL_TELEMETRY=0 short-circuits emit but
//      leaves rate-limiting intact (rate-limit is independent of obs).

export type ToolEffect = "read" | "write" | "instruction-only";

export interface ToolTelemetryOpts<Args> {
  tool: string;
  kind: ToolKind;
  effect: ToolEffect;
  workspaceId: string | undefined;
  argsShape: (args: Args) => Record<string, unknown>;
}

type ToolResponseLike = { isError?: boolean } & Record<string, unknown>;

function isErrorResponse(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as ToolResponseLike).isError === true
  );
}

function safeArgsShape<Args>(
  extractor: (args: Args) => Record<string, unknown>,
  args: Args,
): Record<string, unknown> | null {
  try {
    const shape = extractor(args);
    if (shape && typeof shape === "object" && Object.keys(shape).length > 0) {
      return shape;
    }
    return null;
  } catch {
    return null;
  }
}

function buildEvent<Args>(
  opts: ToolTelemetryOpts<Args>,
  args: Args,
  ctx: TelemetryContext,
  outcome: Record<string, unknown>,
): TelemetryEventRow {
  const flags = ctx.flags;
  return {
    tool_call_id: ctx.toolCallId,
    tool: opts.tool,
    kind: opts.kind,
    effect: opts.effect,
    workspace_id: opts.workspaceId ?? null,
    args_shape: safeArgsShape(opts.argsShape, args),
    outcome,
    branch_flags: Object.keys(flags).length > 0 ? flags : null,
    schema_version: 1,
  };
}

function emit<Args>(
  opts: ToolTelemetryOpts<Args>,
  args: Args,
  ctx: TelemetryContext,
  outcome: Record<string, unknown>,
): void {
  try {
    emitTelemetryEvent(buildEvent(opts, args, ctx, outcome));
  } catch (err) {
    // emitTelemetryEvent is already non-throwing; defensive belt-and-braces.
    console.error(`[telemetry] emit threw: ${err}`);
  }
}

export function withTelemetry<Args, R>(
  opts: ToolTelemetryOpts<Args>,
  handler: (args: Args, ctx: TelemetryContext) => Promise<R>,
): (args: Args) => Promise<R> {
  return async (args: Args): Promise<R> => {
    const ctx: TelemetryContext = {
      toolCallId: randomUUID(),
      flags: {},
    };

    const limited = checkToolRateLimit(
      opts.workspaceId ?? "unknown",
      opts.tool,
      opts.kind,
    );
    if (limited) {
      emit(opts, args, ctx, {
        ok: false,
        latency_ms: 0,
        result_count: 0,
        no_results: false,
        error_code: "rate_limited",
        rate_limited: true,
      });
      return rateLimitToolError(limited) as unknown as R;
    }

    const tStart = performance.now();
    let result: R;
    try {
      result = await handler(args, ctx);
    } catch (err) {
      const latencyMs = Math.round(performance.now() - tStart);
      emit(opts, args, ctx, {
        ok: false,
        latency_ms: latencyMs,
        result_count: ctx.resultCount ?? 0,
        no_results: ctx.noResults ?? false,
        error_code: ctx.errorCode ?? "unknown",
        rate_limited: false,
      });
      throw err;
    }

    const latencyMs = Math.round(performance.now() - tStart);
    const isErr = isErrorResponse(result);
    emit(opts, args, ctx, {
      ok: !isErr,
      latency_ms: latencyMs,
      result_count: ctx.resultCount ?? 0,
      no_results: ctx.noResults ?? false,
      error_code: isErr ? (ctx.errorCode ?? "unknown") : null,
      rate_limited: false,
    });
    return result;
  };
}
