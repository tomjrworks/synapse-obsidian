-- Taproot Stage 1 — RLS policies + user_workspaces() helper
-- Pattern: every tenant-scoped table has RLS enabled and policies that scope rows
-- to workspaces the current auth.uid() is a member of. Service role bypasses RLS
-- for the MCP server and Stage 2 workers.
--
-- The helper function user_workspaces() is `security definer` so it can read
-- workspace_members past that table's own RLS — without this, users can't
-- enumerate their own workspace ids (chicken-and-egg).

alter table workspaces        enable row level security;
alter table workspace_members enable row level security;
alter table vault_files       enable row level security;
alter table oauth_clients     enable row level security;
alter table oauth_tokens      enable row level security;
alter table tenant_keys       enable row level security;
alter table helper_devices    enable row level security;

create or replace function user_workspaces() returns setof uuid
  language sql stable security definer
  set search_path = public, pg_temp
as $$
  select workspace_id from workspace_members where user_id = auth.uid()
$$;

-- workspaces
create policy "workspaces_select" on workspaces
  for select using (id in (select user_workspaces()));

create policy "workspaces_update" on workspaces
  for update using (owner_user_id = auth.uid());

create policy "workspaces_insert" on workspaces
  for insert with check (owner_user_id = auth.uid());

-- workspace_members
create policy "workspace_members_select" on workspace_members
  for select using (workspace_id in (select user_workspaces()));

create policy "workspace_members_modify" on workspace_members
  for all using (
    workspace_id in (
      select id from workspaces where owner_user_id = auth.uid()
    )
  );

-- vault_files (read via dashboard; writes are service-role-only)
create policy "vault_files_select" on vault_files
  for select using (workspace_id in (select user_workspaces()));

-- oauth_clients
create policy "oauth_clients_select" on oauth_clients
  for select using (workspace_id in (select user_workspaces()));

create policy "oauth_clients_modify" on oauth_clients
  for all using (
    workspace_id in (
      select id from workspaces where owner_user_id = auth.uid()
    )
  );

-- oauth_tokens (dashboard sees connected clients; owner-only revoke)
create policy "oauth_tokens_select" on oauth_tokens
  for select using (workspace_id in (select user_workspaces()));

create policy "oauth_tokens_revoke" on oauth_tokens
  for update using (
    workspace_id in (
      select id from workspaces where owner_user_id = auth.uid()
    )
  );

-- tenant_keys: NO client policies. RLS enabled = deny by default = service role only.

-- helper_devices
create policy "helper_devices_select" on helper_devices
  for select using (workspace_id in (select user_workspaces()));

create policy "helper_devices_revoke" on helper_devices
  for update using (
    workspace_id in (
      select id from workspaces where owner_user_id = auth.uid()
    )
  );
