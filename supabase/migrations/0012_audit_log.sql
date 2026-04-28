-- Taproot Stage 1 — audit_log table
-- Records every server-side access to encrypted vault content (DEK unwrap,
-- vault read/write through service-role pipeline, OAuth token issuance, helper
-- pair, leave-taproot nuke). One row per operation.
--
-- No UI in Stage 1. The data exists for incident response and for the future
-- "show me everything that touched my vault" user surface (Stage 5+).
--
-- RLS: enabled with NO policies = deny by default for client roles. Writes
-- and reads are service-role-only. The Cloudflare Worker writes a row inside
-- the same handler that performs the access; if the write fails, the access
-- still proceeds (audit failure must not block user requests).
--
-- Sequential bigint id is intentional — log tables don't benefit from UUIDs,
-- and a sequence is cheaper to insert + index. Not exposed externally.

create table audit_log (
  id            bigint generated always as identity primary key,
  workspace_id  uuid references workspaces(id) on delete cascade,
  user_id       uuid references auth.users(id) on delete set null,
  operation     text not null,
  details       jsonb not null default '{}'::jsonb,
  ip            inet,
  user_agent    text,
  created_at    timestamptz not null default now()
);

-- Operations are unconstrained text for flexibility. Conventional values used
-- by the Cloudflare Worker:
--   kek_unwrap            — DEK unwrap to serve a vault read or write
--   workspace_created     — atomic signup completed
--   oauth_token_issued    — third-party MCP client authorized
--   oauth_token_revoked   — third-party MCP client revoked
--   helper_paired         — Mac helper completed first-run pair flow
--   helper_revoked        — Mac helper revoked from dashboard
--   vault_export          — user requested data export
--   vault_nuke            — "Leave Taproot" clicked; mirror deleted

create index audit_log_workspace_created_idx
  on audit_log(workspace_id, created_at desc);

create index audit_log_operation_created_idx
  on audit_log(operation, created_at desc);

-- workspace_id can be null for pre-workspace events (e.g., signup_failed
-- before the workspace row was created). Index handles either case via the
-- workspace+time path; operation+time covers the "all kek_unwraps in last
-- 24h" incident-response query.

alter table audit_log enable row level security;

-- Intentionally NO policies. RLS enabled + zero policies = deny by default
-- for anon and authenticated roles. Service role bypasses RLS as usual.
