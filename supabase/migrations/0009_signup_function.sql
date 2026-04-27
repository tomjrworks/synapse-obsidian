-- Taproot Stage 1 — Atomic signup helper
-- Called from the server-side /api/signup handler with the service-role client
-- to create workspaces + workspace_members + tenant_keys in one transaction
-- without tripping RLS chicken-and-egg.

create or replace function create_workspace_for_new_user(
  p_user_id        uuid,
  p_workspace_name text,
  p_wrapped_dek    bytea
) returns uuid
  language plpgsql security definer
  set search_path = public, pg_temp
as $$
declare
  v_workspace_id uuid;
begin
  insert into workspaces (name, owner_user_id, workspace_type, settings)
    values (
      p_workspace_name,
      p_user_id,
      'personal',
      '{"onboarding_step": "persona", "persona": null, "connected_clients": []}'::jsonb
    )
    returning id into v_workspace_id;

  insert into workspace_members (workspace_id, user_id, role, joined_at)
    values (v_workspace_id, p_user_id, 'owner', now());

  insert into tenant_keys (workspace_id, wrapped_dek)
    values (v_workspace_id, p_wrapped_dek);

  return v_workspace_id;
end;
$$;
