-- Taproot Stage 1 — Update create_workspace_for_new_user to accept a pre-generated workspace_id
-- The Node signup handler generates the workspace UUID before wrapping the DEK so that the
-- workspace_id can be bound as AAD in the AES-GCM wrap. Without this the DEK wrap and the
-- workspace row use different IDs, breaking unwrap at sync time.

create or replace function create_workspace_for_new_user(
  p_user_id        uuid,
  p_workspace_name text,
  p_wrapped_dek    bytea,
  p_workspace_id   uuid default gen_random_uuid()
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
