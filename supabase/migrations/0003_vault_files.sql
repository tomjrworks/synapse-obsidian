-- Taproot Stage 1 — Vault file metadata
-- Blobs (ciphertext) live in Supabase Storage at {workspace_id}/{vault_files.id}.
-- This table holds path, size, mtime, sha256 of plaintext, etc.

create table vault_files (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  path              text not null,
  size_bytes        bigint not null,
  plaintext_sha256  bytea,
  mime_type         text,
  storage_object    text not null,
  modified_at       timestamptz not null,
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz
);

-- Partial unique index (replaces the partial unique constraint in the data model doc —
-- Postgres supports partial unique INDEXES, not partial unique CONSTRAINTS).
-- Soft-deleting a file at `path` and creating a new one at the same `path` works cleanly.
create unique index vault_files_workspace_path_unique
  on vault_files(workspace_id, path)
  where deleted_at is null;

-- Recent-files lookup for `garden_recent`.
create index vault_files_workspace_modified_idx
  on vault_files(workspace_id, modified_at desc)
  where deleted_at is null;
