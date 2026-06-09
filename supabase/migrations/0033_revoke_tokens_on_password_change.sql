-- M1: revoke all bearers for a user when their password changes.
-- Fires via a trigger on auth.users whenever encrypted_password changes.
-- SECURITY DEFINER so the function runs as the owning role (postgres)
-- and can UPDATE public.oauth_tokens regardless of RLS.
-- The WHEN clause prevents the function body from running on unrelated
-- auth.users column updates (e.g. last_sign_in_at, email confirmation).

CREATE OR REPLACE FUNCTION public.revoke_bearer_on_password_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE oauth_tokens
  SET revoked_at = now()
  WHERE user_id = NEW.id
    AND revoked_at IS NULL;
  RETURN NEW;
END;
$$;

CREATE TRIGGER revoke_bearer_on_password_change
AFTER UPDATE ON auth.users
FOR EACH ROW
WHEN (NEW.encrypted_password IS DISTINCT FROM OLD.encrypted_password)
EXECUTE FUNCTION public.revoke_bearer_on_password_change();
