-- Taproot Stage 1 — Helper device registrations
-- One row per Mac/Win/Linux helper installation. First-party auth (bootstrap secret),
-- not OAuth — different lifecycle and revocation UX from third-party MCP clients.

create table helper_devices (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  device_name         text not null,
  device_secret_hash  bytea not null,
  os_platform         text,
  installed_at        timestamptz not null default now(),
  last_seen_at        timestamptz,
  revoked_at          timestamptz
);

create index helper_devices_workspace_idx
  on helper_devices(workspace_id)
  where revoked_at is null;

create index helper_devices_secret_hash_idx
  on helper_devices(device_secret_hash)
  where revoked_at is null;
