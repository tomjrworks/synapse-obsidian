-- Taproot Stage 1 — pair_tokens RLS (gap fix)
-- pair_tokens was added in 0010 after the RLS migration in 0007 and was not
-- covered. With RLS off, any authenticated user could SELECT * from pair_tokens
-- and race-claim another user's helper pair flow.
--
-- Fix: enable RLS with no policies = deny by default for all client roles.
-- Pair tokens are minted and consumed exclusively via the service role
-- (POST /api/helper/pair-token mints; helper's first-run flow consumes through
-- a server-side path that uses the service role to validate + mark consumed).
-- No client-side query path exists or is intended.

alter table pair_tokens enable row level security;

-- Intentionally NO policies. RLS enabled + zero policies = all client roles
-- (anon, authenticated) get DENY on every operation. Service role bypasses
-- RLS as usual.
