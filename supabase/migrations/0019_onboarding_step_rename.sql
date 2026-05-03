-- 0019: rename onboarding_step values to match SITE 10-step hyphenated convention.
--   vault_folder -> vault
--   first_wow    -> first-wow
-- All other names (persona, obsidian, helper, permissions, clients, complete) pass through unchanged.
-- Idempotent: rerunning is a no-op since the second pass finds no rows with the old names.

UPDATE workspaces
SET settings = jsonb_set(
  settings,
  '{onboarding_step}',
  CASE settings->>'onboarding_step'
    WHEN 'vault_folder' THEN '"vault"'::jsonb
    WHEN 'first_wow'    THEN '"first-wow"'::jsonb
    ELSE settings->'onboarding_step'
  END
)
WHERE settings->>'onboarding_step' IN ('vault_folder', 'first_wow');
