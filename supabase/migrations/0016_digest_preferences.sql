-- Taproot Stage 1 — Digest preferences table + signup trigger
-- One row per workspace, created at signup via service role. Users can read + update
-- their own preferences; INSERT is service-role-only (created atomically with the workspace).

create table digest_preferences (
  workspace_id     uuid primary key references workspaces(id) on delete cascade,
  email_subscribed boolean not null default true,
  send_dow         smallint not null default 0,   -- 0 = sunday; future: customizable
  send_hour        smallint not null default 6,   -- 06:00 user-tz; future: customizable
  user_tz          text not null default 'America/New_York',
  updated_at       timestamptz not null default now()
);

alter table digest_preferences enable row level security;

create policy "digest_preferences_select" on digest_preferences
  for select using (workspace_id in (select user_workspaces()));

create policy "digest_preferences_update" on digest_preferences
  for update using (workspace_id in (select user_workspaces()));

-- Trigger: create a default digest_preferences row whenever a new workspace is inserted.
-- Runs as security definer so the insert isn't blocked by the INSERT-only-service-role policy.
create or replace function create_digest_preferences_for_workspace()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  insert into digest_preferences (workspace_id)
    values (new.id)
    on conflict (workspace_id) do nothing;
  return new;
end;
$$;

create trigger trg_workspace_digest_preferences
  after insert on workspaces
  for each row execute function create_digest_preferences_for_workspace();
