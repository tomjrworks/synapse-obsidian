-- 0028: Seed new workspaces with onboarding_step="clients" instead of "persona".
--
-- The 2026-05-11 trait removal deleted the "persona" wizard step on SITE
-- (replaced by "clients") and added a coerceLegacyStep("persona") -> "clients"
-- shim in SITE's src/lib/api.ts. The migration that seeds settings for new
-- workspaces (0021) was never updated to match, so every signup since 2026-05-11
-- gets onboarding_step="persona" in the DB.
--
-- This was latent until PR #4 (2026-05-20) wrapped /api/onboarding/clients
-- and the other 7 step routes in `withOnboardingStep("clients", ...)`. The
-- guard at src/lib/onboarding-step.ts:18-20 compared the raw DB value against
-- the canonical "clients" literal and returned 400 precondition_failed for
-- every fresh signup. The companion SITE fix in this PR adds the
-- coerceLegacyStep call inside the guard so existing rows self-heal on first
-- advance, but new rows should be seeded with the canonical value.
--
-- This migration:
--   1) Redefines create_workspace_for_new_user to seed onboarding_step="clients".
--   2) Backfills existing rows: persona -> clients, vault -> obsidian.
--      (vault was renamed 2026-05-06 in the Obsidian-required pivot but
--      the SITE coerce shim has been there longer than the SITE guard, so
--      vault-rows haven't been visibly broken — backfilling for hygiene.)

create or replace function public.create_workspace_for_new_user(
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
      '{"onboarding_step": "clients", "persona": null, "connected_clients": []}'::jsonb
    );

  insert into workspace_members (workspace_id, user_id, role, joined_at)
    values (p_workspace_id, p_user_id, 'owner', now());

  insert into tenant_keys (workspace_id, wrapped_dek)
    values (p_workspace_id, p_wrapped_dek);

  return p_workspace_id;
end;
$$;

-- Backfill: drag legacy onboarding_step values forward to canonical names.
-- Idempotent: rerunning is a no-op once no rows match the WHERE clause.
UPDATE workspaces
SET settings = jsonb_set(
  settings,
  '{onboarding_step}',
  CASE settings->>'onboarding_step'
    WHEN 'persona' THEN '"clients"'::jsonb
    WHEN 'vault'   THEN '"obsidian"'::jsonb
    ELSE settings->'onboarding_step'
  END
)
WHERE settings->>'onboarding_step' IN ('persona', 'vault');

-- Verification (run manually after migration applies):
--   select count(*) from workspaces
--     where settings->>'onboarding_step' in ('persona', 'vault');
--   -- expect 0.
