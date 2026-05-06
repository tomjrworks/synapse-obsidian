-- Taproot Workstream C — vault_files.flags JSONB column (F7 outside-rules hook).
-- Additive only. Defaults to '{}' so existing rows + the helper sync handler
-- need no changes. Workstream F populates flags.outside_rules later; the
-- dashboard's OutsideRulesBanner reads the count via the partial index below.
-- RLS is inherited from existing vault_files_select policy — no new policies.

alter table vault_files
  add column flags jsonb not null default '{}'::jsonb;

-- Partial index: cheap workspace-scoped count(*) for the F7 banner. Excludes
-- soft-deleted rows and only indexes rows with the outside_rules key set.
create index vault_files_workspace_outside_rules_idx
  on vault_files (workspace_id)
  where deleted_at is null and (flags ? 'outside_rules');
