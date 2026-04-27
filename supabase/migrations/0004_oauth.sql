-- Taproot Stage 1 — OAuth clients + tokens
-- Workspace-scoped MCP clients (claude.ai, ChatGPT, Cursor, etc.) and the bearer
-- tokens issued to them. Tokens stored hashed; raw token is never persisted.

create table oauth_clients (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  client_id           text unique not null,
  client_name         text not null,
  redirect_uris       text[] not null,
  registered_at       timestamptz not null default now(),
  last_authorized_at  timestamptz,
  revoked_at          timestamptz
);

create index oauth_clients_workspace_idx
  on oauth_clients(workspace_id)
  where revoked_at is null;

create table oauth_tokens (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  client_id     text not null references oauth_clients(client_id) on delete cascade,
  token_hash    bytea not null unique,
  scopes        text[] not null default '{}',
  issued_at     timestamptz not null default now(),
  expires_at    timestamptz not null,
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

create index oauth_tokens_token_hash_idx
  on oauth_tokens(token_hash)
  where revoked_at is null;

create index oauth_tokens_workspace_idx
  on oauth_tokens(workspace_id)
  where revoked_at is null;
