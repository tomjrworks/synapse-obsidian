-- M1-c: backfill user_id on any active oauth_tokens row still missing it.
--
-- Motivating case: mintHelperBearer (src/api/helper.ts) inserted helper-mac
-- bearers without user_id until M1-c. Migration 0032's one-time backfill only
-- covered rows that existed when 0032 ran — helper bearers minted AFTER 0032
-- (pairing / direct-auth) were NULL again, so the 0033 password-change revoke
-- trigger (WHERE user_id = NEW.id) silently skipped them.
--
-- The UPDATE is intentionally path-agnostic: it fills EVERY active NULL row,
-- not just helper rows. Under the Stage-1 invariant (one user per workspace),
-- workspaces.owner_user_id is the correct owner for any token in the
-- workspace regardless of which mint path created it, so a broad backfill is
-- both correct and more complete than a helper-scoped one. Same logic as 0032.
-- Scoped to revoked_at IS NULL — no point touching already-dead tokens; and
-- to user_id IS NULL — never overwrites an already-bound row.
--
-- KNOWN LIMITATION (inherited from 0032): owner_user_id binding assumes one
-- user per workspace. Must be revisited before multi-member workspaces ship —
-- a non-owner's bearer would be bound to the owner's id.

UPDATE oauth_tokens
  SET user_id = (
    SELECT owner_user_id FROM workspaces WHERE id = oauth_tokens.workspace_id
  )
  WHERE user_id IS NULL
    AND revoked_at IS NULL;
