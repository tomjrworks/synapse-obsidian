import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Per-call fresh service-role client. We deliberately don't memoize here:
// supabase-js's `auth.getUser(jwt)` (used in middleware to verify the bearer
// token) mutates the client's auth state, which silently downgrades subsequent
// DB calls from `service_role` to the user's `authenticated` role. That breaks
// any operation against an RLS-no-policies table (pair_tokens, tenant_keys,
// audit_log) once auth has been touched. Returning a new client per call keeps
// the service-role bypass guarantee per request handler. Cost: a tiny object
// alloc per call — supabase-js doesn't open a connection until you make a
// query, so there's no socket overhead.
export function supabaseService(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env",
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function supabaseForUser(jwt: string): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env");
  }
  return createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}
