-- Taproot Stage 1 — Deduplicate create_workspace_for_new_user
--
-- Migrations 0009, 0014, and 0018 each emitted CREATE OR REPLACE FUNCTION
-- with different positional arg orders. Postgres function identity is
-- (name, ordered-arg-type-list), so REPLACE only fires when types match in
-- the same order. The result in prod: three coexisting functions.
--
-- PostgREST cannot disambiguate when a caller passes all four args by name
-- (PGRST203), which blocks every fresh signup at POST /api/workspace.
--
-- This migration drops every prior signature and creates one canonical
-- definition. Arg order matches the Node call site at
-- src/api/workspace-create.ts:41-49 (workspace_id first).

drop function if exists public.create_workspace_for_new_user(uuid, uuid, text, bytea);
drop function if exists public.create_workspace_for_new_user(uuid, text, bytea, uuid);
drop function if exists public.create_workspace_for_new_user(uuid, text, bytea);

create function public.create_workspace_for_new_user(
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

-- Verification (run manually after migration applies):
--   select pg_get_function_arguments(oid)
--     from pg_proc
--     where proname = 'create_workspace_for_new_user';
--   -- expect exactly 1 row:
--   --   p_workspace_id uuid, p_user_id uuid, p_workspace_name text, p_wrapped_dek bytea
