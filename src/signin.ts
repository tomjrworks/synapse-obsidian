import { randomBytes } from "node:crypto";
import type { Express, Request, Response } from "express";
import { supabaseService } from "./api/supabase.js";
import { getMembershipForUser } from "./api/workspace.js";
import {
  TOKEN_TTL_SECONDS,
  tokenHashByteaParam,
  escapeHtml,
} from "./auth/bearer.js";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: "Invalid email or password.",
  missing_email: "Email is required.",
  missing_password: "Password is required.",
  invalid_email: "Enter a valid email address.",
  no_workspace: "No workspace found — finish signup at taproothq.com first.",
};

function signinPageHtml(opts: { email?: string; error?: string }): string {
  const { email = "", error } = opts;
  const banner =
    error && ERROR_MESSAGES[error]
      ? `<div class="error-banner">${escapeHtml(ERROR_MESSAGES[error])}</div>`
      : "";
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
    <form method="POST" action="/signin">
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
    </form>
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

export function registerSigninRoutes(app: Express, _baseUrl: string): void {
  app.get("/signin", (req: Request, res: Response) => {
    const email = typeof req.query.email === "string" ? req.query.email : "";
    const error =
      typeof req.query.error === "string" ? req.query.error : undefined;
    if (req.query.source) {
      console.error(`[signin] source=${req.query.source}`);
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(signinPageHtml({ email, error }));
  });

  app.post("/signin", async (req: Request, res: Response) => {
    const email: string = (req.body?.email ?? "").trim();
    const password: string = req.body?.password ?? "";

    if (!email) {
      res.redirect(302, "/signin?error=missing_email");
      return;
    }
    if (!email.includes("@")) {
      res.redirect(
        302,
        `/signin?error=invalid_email&email=${encodeURIComponent(email)}`,
      );
      return;
    }
    if (!password) {
      res.redirect(
        302,
        `/signin?error=missing_password&email=${encodeURIComponent(email)}`,
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
          `/signin?error=invalid_credentials&email=${encodeURIComponent(email)}`,
        );
        return;
      }

      // Fresh service-role client — authClient is tainted by signInWithPassword
      const supa = supabaseService();
      const membership = await getMembershipForUser(supa, auth.user.id);
      if (!membership) {
        res.redirect(
          302,
          `/signin?error=no_workspace&email=${encodeURIComponent(email)}`,
        );
        return;
      }
      const { workspaceId } = membership;
      const syntheticClientId = `taproot-helper-${workspaceId}`;

      const { error: upsertErr } = await supa.from("oauth_clients").upsert(
        {
          workspace_id: workspaceId,
          client_id: syntheticClientId,
          client_name: "Taproot Helper (direct signin)",
          redirect_uris: ["taproot://auth"],
          last_authorized_at: new Date().toISOString(),
        },
        { onConflict: "client_id" },
      );
      if (upsertErr) {
        console.error(
          `[signin] oauth_clients upsert failed: ${upsertErr.message}`,
        );
        res
          .status(500)
          .send(
            errorPageHtml(
              "Sign-in succeeded but bearer issuance failed. Please try again.",
            ),
          );
        return;
      }

      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(
        Date.now() + TOKEN_TTL_SECONDS * 1000,
      ).toISOString();
      const { error: insertErr } = await supa.from("oauth_tokens").insert({
        workspace_id: workspaceId,
        client_id: syntheticClientId,
        token_hash: tokenHashByteaParam(token),
        expires_at: expiresAt,
      });
      if (insertErr) {
        console.error(
          `[signin] oauth_tokens insert failed: ${insertErr.message}`,
        );
        res
          .status(500)
          .send(
            errorPageHtml(
              "Sign-in succeeded but bearer issuance failed. Please try again.",
            ),
          );
        return;
      }

      const deepLink = new URL("taproot://auth");
      deepLink.searchParams.set("bearer", token);
      deepLink.searchParams.set("workspace", workspaceId);
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
}
