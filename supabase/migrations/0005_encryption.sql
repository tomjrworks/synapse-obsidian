-- Taproot Stage 1 — Per-tenant wrapped DEKs
-- KEK lives in Cloudflare Secrets (separate trust boundary from Supabase).
-- Service role only — RLS denies all client access (no policies = deny by default).

create table tenant_keys (
  workspace_id  uuid primary key references workspaces(id) on delete cascade,
  wrapped_dek   bytea not null,
  key_version   int not null default 1,
  algorithm     text not null default 'AES-256-GCM',
  rotated_at    timestamptz not null default now(),
  previous_dek  bytea
);
