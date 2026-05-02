-- PR2: drop pair_tokens (abandoned alternative to taproot:// deep-link auth)
-- and update create_workspace_for_new_user to accept a caller-supplied workspace
-- UUID so the server can bind it as AAD when wrapping the DEK.

-- Update signup function to accept a pre-supplied workspace UUID.
-- The caller (auth.ts /api/signup) generates the UUID with randomUUID() and
-- uses it as AAD for wrapDek before calling this RPC, ensuring the wrapped DEK
-- is cryptographically bound to the workspace it belongs to.
create or replace function create_workspace_for_new_user(
  p_workspace_id   uuid,
  p_user_id        uuid,
  p_workspace_name text,
  p_wrapped_dek    bytea
) returns uuid
  language plpgsql security definer
  set search_path = public, pg_temp
as $$
begin
  insert into workspaces (id, name, owner_user_id, workspace_type, settings)
    values (
      p_workspace_id,
      p_workspace_name,
      p_user_id,
      'personal',
      '{"onboarding_step": "persona", "persona": null, "connected_clients": []}'::jsonb
    );

  insert into workspace_members (workspace_id, user_id, role, joined_at)
    values (p_workspace_id, p_user_id, 'owner', now());

  insert into tenant_keys (workspace_id, wrapped_dek)
    values (p_workspace_id, p_wrapped_dek);

  return p_workspace_id;
end;
$$;

-- Drop pair_tokens table and RLS policies.
-- The mint endpoint at /api/helper/pair-token was never consumed by any client;
-- helper-mac uses the taproot://auth?bearer= deep-link flow instead.
drop policy if exists "workspace members can insert pair tokens" on pair_tokens;
drop policy if exists "workspace members can select pair tokens" on pair_tokens;
drop policy if exists "workspace members can delete pair tokens" on pair_tokens;
drop table if exists pair_tokens;
