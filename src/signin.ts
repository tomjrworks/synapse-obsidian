import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { LRUCache } from "lru-cache";
import { supabaseService } from "./api/supabase.js";
import { getMembershipForUser } from "./api/workspace.js";
import {
  TOKEN_TTL_SECONDS,
  tokenHashByteaParam,
  escapeHtml,
} from "./auth/bearer.js";

// PKCE base64url (RFC 7636 §4.1): 43-128 chars from [A-Za-z0-9-_].
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const CODE_RE = /^[a-f0-9]{64}$/;
const VERIFIER_RE = /^[A-Za-z0-9_-]{43,128}$/;

interface SigninCode {
  workspaceId: string;
  userId: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  expiresAt: number;
}

const SIGNIN_CODE_TTL_MS = 5 * 60 * 1000;
const signinCodes = new LRUCache<string, SigninCode>({
  max: 10_000,
  ttl: SIGNIN_CODE_TTL_MS,
});

// Test-only seam: lets `scripts/test-signin-exchange.ts` simulate code expiry
// without sleeping for 5 minutes. NOT exported through any other surface.
export function __testExpireSigninCode(code: string): boolean {
  const entry = signinCodes.get(code);
  if (!entry) return false;
  signinCodes.set(code, { ...entry, expiresAt: Date.now() - 1 });
  return true;
}

const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: "Invalid email or password.",
  missing_email: "Email is required.",
  missing_password: "Password is required.",
  invalid_email: "Enter a valid email address.",
  no_workspace: "No workspace found — finish signup at taproothq.com first.",
  helper_required:
    "Open Taproot from your menu bar to sign in — this page must be launched from the helper.",
};

interface PageOpts {
  email?: string;
  error?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  hideForm?: boolean;
}

function signinPageHtml(opts: PageOpts): string {
  const {
    email = "",
    error,
    codeChallenge = "",
    codeChallengeMethod = "",
    hideForm = false,
  } = opts;
  const banner =
    error && ERROR_MESSAGES[error]
      ? `<div class="error-banner">${escapeHtml(ERROR_MESSAGES[error])}</div>`
      : "";
  const formBlock = hideForm
    ? ""
    : `<form method="POST" action="/signin">
      <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}" />
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod)}" />
      <label for="email">Email</label>
      <input
        type="email"
        id="email"
        name="email"
        autocomplete="email"
        value="${escapeHtml(email)}"
        required
      />
      <label for="password">Password</label>
      <input
        type="password"
        id="password"
        name="password"
        autocomplete="current-password"
        required
      />
      <button type="submit">Continue</button>
    </form>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign in — Taproot</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link
    href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;1,9..144,400;1,9..144,500&family=Inter:wght@400;500&display=swap"
    rel="stylesheet"
  />
  <style>
    :root {
      --color-cream: #EAE5D6;
      --color-bark: #3D3529;
      --color-forest-dark: #1A5C32;
      --color-stone: #8B9490;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: var(--color-cream);
      color: var(--color-bark);
      font-family: 'Inter', system-ui, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 2.5rem 2rem;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 2px 16px rgba(26, 92, 50, 0.08);
    }
    .wordmark {
      font-family: 'Fraunces', serif;
      font-size: 1.1rem;
      font-weight: 500;
      color: var(--color-forest-dark);
      margin-bottom: 1.75rem;
      letter-spacing: -0.01em;
    }
    h1 {
      font-family: 'Fraunces', serif;
      font-size: 1.75rem;
      font-weight: 500;
      line-height: 1.25;
      color: var(--color-bark);
      margin-bottom: 1.75rem;
    }
    h1 em {
      font-style: italic;
      color: var(--color-forest-dark);
    }
    .error-banner {
      background: #FEF2F2;
      color: #B91C1C;
      border-radius: 8px;
      padding: 0.625rem 0.875rem;
      font-size: 0.875rem;
      margin-bottom: 1.25rem;
    }
    label {
      display: block;
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--color-stone);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.375rem;
    }
    input[type="email"],
    input[type="password"] {
      width: 100%;
      padding: 0.625rem 0.875rem;
      border: 1.5px solid #D9D3C5;
      border-radius: 8px;
      font-family: 'Inter', system-ui, sans-serif;
      font-size: 0.9375rem;
      color: var(--color-bark);
      background: var(--color-cream);
      margin-bottom: 1.1rem;
      transition: border-color 0.15s;
    }
    input[type="email"]:focus,
    input[type="password"]:focus {
      outline: none;
      border-color: var(--color-forest-dark);
    }
    button[type="submit"] {
      width: 100%;
      padding: 0.75rem 1.5rem;
      background: var(--color-forest-dark);
      color: var(--color-cream);
      font-family: 'Inter', system-ui, sans-serif;
      font-size: 0.9375rem;
      font-weight: 500;
      border: none;
      border-radius: 9999px;
      cursor: pointer;
      margin-top: 0.25rem;
      transition: opacity 0.15s;
    }
    button[type="submit"]:hover { opacity: 0.88; }
  </style>
</head>
<body>
  <div class="card">
    <div class="wordmark">Taproot</div>
    <h1>Sign in to Taproot.<br><em>Pick up where you left off.</em></h1>
    ${banner}
    ${formBlock}
  </div>
</body>
</html>`;
}

function errorPageHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Error — Taproot</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 2rem; max-width: 480px; margin: 0 auto; }
    h1 { color: #B91C1C; margin-bottom: 0.75rem; font-size: 1.25rem; }
    p { color: #3D3529; }
  </style>
</head>
<body>
  <h1>Sign-in error</h1>
  <p>${escapeHtml(message)}</p>
</body>
</html>`;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// Build a /signin redirect URL preserving PKCE params on validation errors so
// the re-rendered form keeps the same in-flight challenge.
function signinRedirectUrl(params: {
  error?: string;
  email?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}): string {
  const sp = new URLSearchParams();
  if (params.error) sp.set("error", params.error);
  if (params.email) sp.set("email", params.email);
  sp.set("code_challenge", params.codeChallenge);
  sp.set("code_challenge_method", params.codeChallengeMethod);
  return `/signin?${sp.toString()}`;
}

export function registerSigninRoutes(app: Express, _baseUrl: string): void {
  app.get("/signin", (req: Request, res: Response) => {
    const email = asString(req.query.email) ?? "";
    const error = asString(req.query.error);
    const codeChallenge = asString(req.query.code_challenge) ?? "";
    const codeChallengeMethod = asString(req.query.code_challenge_method) ?? "";

    if (req.query.source) {
      console.error(`[signin] source=${req.query.source}`);
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");

    // Helper-initiated only: missing or invalid challenge → friendly message,
    // no form rendered. Avoids users discovering /signin organically and
    // submitting creds outside the PKCE flow.
    if (!CHALLENGE_RE.test(codeChallenge) || codeChallengeMethod !== "S256") {
      res
        .status(200)
        .send(signinPageHtml({ error: "helper_required", hideForm: true }));
      return;
    }

    res.status(200).send(
      signinPageHtml({
        email,
        error,
        codeChallenge,
        codeChallengeMethod,
      }),
    );
  });

  app.post("/signin", async (req: Request, res: Response) => {
    const email: string = (asString(req.body?.email) ?? "").trim();
    const password: string = asString(req.body?.password) ?? "";
    const codeChallenge = asString(req.body?.code_challenge) ?? "";
    const codeChallengeMethod = asString(req.body?.code_challenge_method) ?? "";

    // PKCE is mandatory — no fallback to direct bearer minting.
    if (!CHALLENGE_RE.test(codeChallenge) || codeChallengeMethod !== "S256") {
      res.status(400).json({
        error: "invalid_request",
        error_description:
          "code_challenge + code_challenge_method=S256 required",
      });
      return;
    }

    if (!email) {
      res.redirect(
        302,
        signinRedirectUrl({
          error: "missing_email",
          codeChallenge,
          codeChallengeMethod,
        }),
      );
      return;
    }
    if (!email.includes("@")) {
      res.redirect(
        302,
        signinRedirectUrl({
          error: "invalid_email",
          email,
          codeChallenge,
          codeChallengeMethod,
        }),
      );
      return;
    }
    if (!password) {
      res.redirect(
        302,
        signinRedirectUrl({
          error: "missing_password",
          email,
          codeChallenge,
          codeChallengeMethod,
        }),
      );
      return;
    }

    try {
      const authClient = supabaseService();
      const { data: auth, error: authError } =
        await authClient.auth.signInWithPassword({
          email,
          password,
        });
      if (authError || !auth?.user) {
        res.redirect(
          302,
          signinRedirectUrl({
            error: "invalid_credentials",
            email,
            codeChallenge,
            codeChallengeMethod,
          }),
        );
        return;
      }

      // Fresh service-role client — authClient is tainted by signInWithPassword
      const supa = supabaseService();
      const membership = await getMembershipForUser(supa, auth.user.id);
      if (!membership) {
        res.redirect(
          302,
          signinRedirectUrl({
            error: "no_workspace",
            email,
            codeChallenge,
            codeChallengeMethod,
          }),
        );
        return;
      }

      // Mint single-use auth code (5-min TTL). Bearer is NOT issued here —
      // the helper exchanges the code at POST /signin/exchange after proving
      // possession of the code_verifier (PKCE). See B1 plan
      // /Users/miloman/.claude/plans/cosmic-gathering-lark.md.
      const code = randomBytes(32).toString("hex");
      signinCodes.set(code, {
        workspaceId: membership.workspaceId,
        userId: auth.user.id,
        codeChallenge,
        codeChallengeMethod: "S256",
        expiresAt: Date.now() + SIGNIN_CODE_TTL_MS,
      });

      const deepLink = new URL("taproot://auth");
      deepLink.searchParams.set("code", code);
      deepLink.searchParams.set("workspace", membership.workspaceId);
      res.redirect(302, deepLink.toString());
    } catch {
      if (!res.headersSent) {
        res
          .status(500)
          .send(
            errorPageHtml(
              "Authentication unavailable. Please try again shortly.",
            ),
          );
      }
    }
  });

  app.post("/signin/exchange", async (req: Request, res: Response) => {
    const code = asString(req.body?.code) ?? "";
    const codeVerifier = asString(req.body?.code_verifier) ?? "";

    if (!CODE_RE.test(code)) {
      res.status(400).json({ error: "invalid_code" });
      return;
    }
    if (!VERIFIER_RE.test(codeVerifier)) {
      res.status(400).json({ error: "invalid_verifier" });
      return;
    }

    const entry = signinCodes.get(code);
    if (!entry) {
      res.status(400).json({ error: "invalid_code" });
      return;
    }
    // Single-use: consume the code BEFORE the PKCE check so a wrong verifier
    // doesn't leak code validity (no oracle for guessing the verifier).
    signinCodes.delete(code);

    if (entry.expiresAt < Date.now()) {
      res.status(400).json({ error: "expired" });
      return;
    }

    // PKCE verify — mirror oauth.ts /token (lines 577-592). Length check
    // first because timingSafeEqual throws on mismatched lengths.
    const computed = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    const expected = Buffer.from(entry.codeChallenge);
    const actual = Buffer.from(computed);
    if (
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      res.status(400).json({ error: "pkce_mismatch" });
      return;
    }

    try {
      const supa = supabaseService();
      const syntheticClientId = `taproot-helper-${entry.workspaceId}`;

      const { error: clientErr } = await supa.from("oauth_clients").upsert(
        {
          workspace_id: entry.workspaceId,
          client_id: syntheticClientId,
          client_name: "Taproot Helper (direct signin)",
          redirect_uris: ["taproot://auth"],
          last_authorized_at: new Date().toISOString(),
        },
        { onConflict: "client_id" },
      );
      if (clientErr) {
        console.error(
          `[signin/exchange] oauth_clients upsert failed: ${clientErr.message}`,
        );
        res.status(500).json({ error: "server_error" });
        return;
      }

      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(
        Date.now() + TOKEN_TTL_SECONDS * 1000,
      ).toISOString();
      const { error: insertErr } = await supa.from("oauth_tokens").insert({
        workspace_id: entry.workspaceId,
        client_id: syntheticClientId,
        token_hash: tokenHashByteaParam(token),
        expires_at: expiresAt,
      });
      if (insertErr) {
        console.error(
          `[signin/exchange] oauth_tokens insert failed: ${insertErr.message}`,
        );
        res.status(500).json({ error: "server_error" });
        return;
      }

      res.json({
        bearer: token,
        workspace_id: entry.workspaceId,
        expires_at: expiresAt,
      });
    } catch (err: any) {
      console.error(`[signin/exchange] unexpected: ${err?.message ?? err}`);
      if (!res.headersSent) {
        res.status(500).json({ error: "server_error" });
      }
    }
  });
}
