-- M1: bind bearer tokens to the issuing user so a password-reset hook
-- can revoke them. Column is nullable to avoid blocking existing rows;
-- backfill via workspaces.owner_user_id (Stage 1: one user per workspace).

ALTER TABLE oauth_tokens
  ADD COLUMN user_id uuid references auth.users(id) on delete cascade;

UPDATE oauth_tokens
  SET user_id = (
    SELECT owner_user_id FROM workspaces WHERE id = oauth_tokens.workspace_id
  )
  WHERE user_id IS NULL;

CREATE INDEX oauth_tokens_user_id_idx
  ON oauth_tokens(user_id)
  WHERE revoked_at IS NULL;
