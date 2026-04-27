-- Taproot Stage 1 — Workspaces + members
-- Tenant boundary. v1 = one row per user (workspace_type='personal').
-- workspace_type column lands now for forward-compat with Stage 2 teams.

create type workspace_role as enum ('owner', 'admin', 'member');

create table workspaces (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  owner_user_id   uuid not null references auth.users(id) on delete restrict,
  workspace_type  text not null default 'personal'
    check (workspace_type in ('personal', 'team')),
  created_at      timestamptz not null default now(),
  settings        jsonb not null default '{}'::jsonb,
  deleted_at      timestamptz,

  constraint workspaces_name_not_empty check (length(name) > 0)
);

create index workspaces_owner_user_id_idx
  on workspaces(owner_user_id)
  where deleted_at is null;

create table workspace_members (
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  role            workspace_role not null default 'member',
  invited_at      timestamptz not null default now(),
  joined_at       timestamptz,

  primary key (workspace_id, user_id)
);

create index workspace_members_user_id_idx
  on workspace_members(user_id);
