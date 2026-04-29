/**
 * Shared test fixtures for HTTP smoke scripts.
 *
 * Lifted from per-script copies in test-mcp-routing / test-mcp-end-to-end /
 * test-oauth-tokens / test-oauth-supabase-bridge / smoke-sync-push /
 * smoke-onboarding (the inline B1 OAuth bearer block). Each script previously
 * carried a near-identical copy; A1 (Apr 29 audit) consolidates them.
 *
 * Exports:
 *   - provisionTenant({ testName, suffix }) — Supabase auth user + workspace
 *     + tenant_keys row in one shot. Returns { email, userId, workspaceId }.
 *     Email + workspace_name + auth password are all derived from testName +
 *     suffix; callers that combine provisionTenant + obtainBearer pass the
 *     same testName to both, so the password matches.
 *   - obtainBearer({ baseUrl, email, password, testName }) — full OAuth 2.1
 *     + PKCE handshake against a running server. Returns { bearer, clientId }
 *     (callers that only need the bearer destructure { bearer }).
 *   - waitForHealth(url, timeoutMs?) — poll ${url}/health until 200 or
 *     timeout (default 8s). Positional args (matches all 5 prior copies).
 *   - sb — shared Supabase admin client. Each caller previously instantiated
 *     its own; consolidating saves ~5 lines per script and one import.
 *
 * Defensive checks: every step in obtainBearer throws with a body slice on
 * failure (the Copy-1 shape from test-mcp-routing.ts:73-139 — the most
 * rigorous of the 4 prior copies). The other 3 copies will gain reg.ok /
 * tokenRes.ok / access_token-truthy checks for free.
 */
import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";
import { generateDek, wrapDek } from "../../src/api/crypto.js";

export interface Tenant {
  email: string;
  userId: string;
  workspaceId: string;
}

export const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

export async function waitForHealth(
  url: string,
  timeoutMs = 8000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

export async function provisionTenant({
  testName,
  suffix,
}: {
  testName: string;
  suffix: string;
}): Promise<Tenant> {
  const email = `${testName}-${suffix}-${Date.now()}@taproot-test.local`;
  // Same shape as every per-script PASSWORD constant: `${testName}-pw-12345`.
  // Callers that drive obtainBearer pass the same testName, so the helper's
  // password and obtainBearer's password match by construction.
  const password = `${testName}-pw-12345`;
  const { data: userData, error: userErr } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userErr || !userData.user) throw userErr ?? new Error("no user");
  const userId = userData.user.id;
  const wrappedParam = `\\x${wrapDek(generateDek()).toString("hex")}`;
  const { data: ws, error: wsErr } = await sb.rpc(
    "create_workspace_for_new_user",
    {
      p_user_id: userId,
      p_workspace_name: `${testName}-${suffix}`,
      p_wrapped_dek: wrappedParam,
    },
  );
  if (wsErr) throw wsErr;
  return { email, userId, workspaceId: ws as string };
}

export async function obtainBearer({
  baseUrl,
  email,
  password,
  testName,
}: {
  baseUrl: string;
  email: string;
  password: string;
  testName: string;
}): Promise<{ bearer: string; clientId: string }> {
  // 1. /register — dynamic client registration
  const reg = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: `${testName}-client-${email}`,
      redirect_uris: ["http://localhost/oauth/callback"],
    }),
  });
  if (!reg.ok) throw new Error(`/register failed: ${reg.status}`);
  const { client_id } = (await reg.json()) as { client_id: string };
  if (!client_id) throw new Error(`/register returned no client_id`);

  // 2. PKCE pair
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  // 3. /authorize — POST the form directly. Server returns 302 with `code`.
  const authForm = new URLSearchParams({
    client_id,
    redirect_uri: "http://localhost/oauth/callback",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state: testName,
    email,
    password,
  });
  const authRes = await fetch(`${baseUrl}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: authForm.toString(),
    redirect: "manual",
  });
  if (authRes.status !== 302) {
    const body = await authRes.text();
    throw new Error(
      `/authorize expected 302, got ${authRes.status}: ${body.slice(0, 200)}`,
    );
  }
  const location = authRes.headers.get("location") ?? "";
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error(`/authorize redirect missing code: ${location}`);

  // 4. /token — exchange code for bearer
  const tokenForm = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: "http://localhost/oauth/callback",
    client_id,
    code_verifier: codeVerifier,
  });
  const tokenRes = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenForm.toString(),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    throw new Error(`/token failed ${tokenRes.status}: ${body.slice(0, 200)}`);
  }
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  if (!access_token) throw new Error(`/token returned no access_token`);
  return { bearer: access_token, clientId: client_id };
}
