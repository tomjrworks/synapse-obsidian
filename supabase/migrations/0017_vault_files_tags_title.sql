-- Taproot Stage 1 — vault_files: plaintext tags + title columns (spec §G12 adjustment)
-- Helper-mac extracts frontmatter during sync push and uploads tags/title as plaintext
-- alongside the ciphertext blob. Low-sensitivity by nature; body encryption posture unchanged.
-- RLS is inherited from the existing vault_files_select policy — no new policies needed.

alter table vault_files add column tags  text[] not null default '{}';
alter table vault_files add column title text;

-- GIN index for tag-array containment queries (@> operator) used by /api/dashboard/search.
-- Partial on deleted_at is null — soft-deleted files are excluded from search.
create index vault_files_workspace_tags_gin
  on vault_files using gin (tags)
  where deleted_at is null;
