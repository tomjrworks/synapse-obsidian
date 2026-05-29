-- 0029: Pass 1 observability — per-tool-call telemetry events.
--
-- Captures one row per MCP tool handler invocation: tool name, kind,
-- effect, workspace, args_shape (cardinality only — no vault content),
-- outcome (ok/latency/result_count/no_results/error_code/rate_limited),
-- and per-tool branch_flags. Inserts are fire-and-forget from the
-- withTelemetry wrapper in src/observability/tool-telemetry.ts; loss on
-- crash is acceptable (telemetry is diagnostic, not transactional).
--
-- Sink rationale + alternatives considered:
--   projects/taproot/build/2026-05-28-mcp-pass-1-spec-draft.md §3
--
-- Acceptance criteria + 6 SQL aggregations the indexes are sized for:
--   projects/taproot/build/2026-05-28-mcp-pass-1-evals-draft.md §3
--
-- Retention: out of scope. Add a separate cron in a follow-up. Recommend
-- 30 days for Pass 1 baseline; keep longer for tools where Pass 2-3 A/B
-- happens.
--
-- Note: SPEC §3 drafted this as "0028" before 0028_seed_onboarding_step_clients
-- shipped (2026-05-20). Renumbered to 0029. Schema unchanged.

create table tool_call_events (
  id              bigserial    primary key,
  ts              timestamptz  not null default now(),
  tool_call_id    uuid         not null,
  tool            text         not null,
  kind            text         not null check (kind in ('read', 'write')),
  effect          text         not null check (effect in ('read', 'write', 'instruction-only')),
  workspace_id    text,
  args_shape      jsonb,
  outcome         jsonb        not null,
  branch_flags    jsonb,
  schema_version  smallint     not null default 1
);

-- Per-tool time-series: latency p50/p95, error_rate by tool by day.
create index tool_call_events_tool_ts_idx
  on tool_call_events (tool, ts desc);

-- Per-workspace time-series: utilization + per-tenant baselines.
create index tool_call_events_workspace_ts_idx
  on tool_call_events (workspace_id, ts desc)
  where workspace_id is not null;

-- no_results rate per tool — the Pass 2 honesty-contract anchor.
create index tool_call_events_no_results_idx
  on tool_call_events (tool, ts desc)
  where (outcome->>'no_results')::boolean = true;

-- Error rate per tool — feeds the dashboard's error-by-code breakdown.
create index tool_call_events_errors_idx
  on tool_call_events (tool, ts desc)
  where (outcome->>'ok')::boolean = false;

comment on table tool_call_events is
  'Pass 1 observability — per-tool-call metrics. See projects/taproot/build/2026-05-28-mcp-pass-1-spec-draft.md';

-- RLS — service role only. The withTelemetry wrapper uses supabaseService(),
-- which bypasses RLS; no other role should ever touch this table. Deny-by-
-- default (RLS enabled, no permissive policies) matches processed_webhook_events,
-- workspace_subscriptions, and every other server-managed table.
alter table tool_call_events enable row level security;
-- No permissive policies added.
