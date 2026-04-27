-- Taproot Stage 1 — Helper pair tokens
-- One-time tokens minted by /api/helper/pair-token (wizard step 6) and consumed
-- by the helper's first-run flow via GET /api/helper/pair?token=X to bootstrap a
-- device_secret + workspace_id without the user typing credentials into the helper.

create table pair_tokens (
  token         text primary key,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  expires_at    timestamptz not null,
  consumed_at   timestamptz
);
