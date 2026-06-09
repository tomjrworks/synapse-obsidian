-- M1-c: backfill user_id on helper bearers minted with a NULL user_id.
--
-- mintHelperBearer (src/api/helper.ts) inserted oauth_tokens rows without
-- user_id until M1-c. Migration 0032's one-time backfill only covered rows
-- that existed when 0032 ran — helper bearers minted AFTER 0032 (pairing /
-- direct-auth) are NULL again, so the 0033 password-change revoke trigger
-- (WHERE user_id = NEW.id) silently skips them.
--
-- Same backfill logic as 0032: source the owning user from
-- workspaces.owner_user_id (Stage 1 invariant: one user per workspace).
-- Scoped to revoked_at IS NULL — no point touching already-dead tokens.

UPDATE oauth_tokens
  SET user_id = (
    SELECT owner_user_id FROM workspaces WHERE id = oauth_tokens.workspace_id
  )
  WHERE user_id IS NULL
    AND revoked_at IS NULL;
