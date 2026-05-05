-- Bundle B: revoke_helper_device() RPC + DELETE RLS policy for helper_devices.

-- Atomically soft-deletes a helper device and revokes its oauth_token in one
-- transaction. Returns void on success; raises P0002 (device_not_found) if the
-- device row doesn't exist, belongs to a different workspace, or is already
-- revoked. The oauth_tokens update is best-effort — if no matching token is
-- found (e.g. already expired or never created), the device revocation still
-- succeeds (the device row is the authoritative revocation point).
CREATE OR REPLACE FUNCTION revoke_helper_device(p_device_id uuid, p_workspace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_secret_hash bytea;
BEGIN
  UPDATE helper_devices
    SET revoked_at = now()
  WHERE id = p_device_id
    AND workspace_id = p_workspace_id
    AND revoked_at IS NULL
  RETURNING device_secret_hash INTO v_secret_hash;

  IF v_secret_hash IS NULL THEN
    RAISE EXCEPTION 'device_not_found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE oauth_tokens
    SET revoked_at = now()
  WHERE token_hash = v_secret_hash
    AND workspace_id = p_workspace_id
    AND revoked_at IS NULL;
END;
$$;

-- Defense-in-depth: explicit DELETE RLS policy for helper_devices.
-- Service-role client already bypasses RLS, but if a future code path uses
-- a JWT client, this policy prevents cross-workspace deletes silently
-- returning 0 rows.
CREATE POLICY helper_devices_delete ON helper_devices
  FOR DELETE USING (
    workspace_id IN (
      SELECT id FROM workspaces WHERE owner_user_id = auth.uid()
    )
  );
