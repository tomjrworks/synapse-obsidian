-- Taproot Bundle 5 — Helper pair-token + device registration
-- Recreates the pair_tokens table (originally 0010, dropped by 0014).
-- Raw token is never persisted; only sha256(token) stored as token_hash.

create table pair_tokens (
  token_hash    bytea primary key,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  expires_at    timestamptz not null,
  consumed_at   timestamptz,
  consumed_by_device_id uuid references helper_devices(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index pair_tokens_workspace_active_idx
  on pair_tokens(workspace_id)
  where consumed_at is null;

create index pair_tokens_expiry_idx
  on pair_tokens(expires_at)
  where consumed_at is null;

alter table pair_tokens enable row level security;
-- No policies = service-role only. Mint path validates JWT in middleware;
-- redeem path is unauthenticated (the code itself is the secret).
