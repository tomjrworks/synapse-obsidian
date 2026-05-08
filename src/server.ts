import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { StorageBackend } from "./utils/storage.js";
import { registerVaultTools } from "./tools/vault.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerInitTools } from "./tools/init.js";
import { registerRulesTool } from "./tools/rules.js";
import { registerIndexTool } from "./tools/index-tool.js";
import { assembleInstructions } from "./utils/instructions.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import {
  registerOAuthRoutes,
  requireAuth,
  type AuthedMcpRequest,
} from "./oauth.js";
import { registerSigninRoutes } from "./signin.js";
import { respondError } from "./api/respond-error.js";
import { mountApiRoutes } from "./api/routes.js";
import { getBackend } from "./utils/backend-cache.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "../package.json"), "utf-8"),
);

async function createMcpServer(
  backend: StorageBackend,
  opts: { workspaceId?: string } = {},
): Promise<McpServer> {
  const instructions = await assembleInstructions(backend, {
    workspaceId: opts.workspaceId,
  });
  const server = new McpServer(
    {
      name: "taproot",
      version: pkg.version,
    },
    { instructions },
  );
  registerVaultTools(server, backend);
  registerKnowledgeTools(server, backend);
  registerInitTools(server, backend);
  registerRulesTool(server, backend);
  registerIndexTool(server, backend);
  registerPrompts(server, backend);
  registerResources(server, backend);
  return server;
}

export async function startServer(port: number): Promise<void> {
  const app = express();

  // 10MB cap accommodates batched helper push payloads (up to 500 ops at
  // ~vault-note size). Verified safe globally including /mcp: grep over src/
  // for "413"/payloadTooLarge/content-length found no /mcp tool that depends
  // on the default 100KB cap as backpressure (plan T11.3 §11.1).
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));

  // Add new credential-equivalent keys here; replacer applies at every nesting level.
  const SENSITIVE_BODY_KEYS = new Set([
    "password",
    "email",
    "code_verifier",
    "client_secret",
    "refresh_token",
    "access_token",
    "bearer",
    "jwt",
    "token",
    "code",
  ]);

  // Routes whose request bodies contain user vault content (audit C1, Apr 29).
  // We log a body=[skipped] sentinel — same timestamp/method/path signal as
  // every other request, but no plaintext leak to stderr. Exact-match paths
  // only; /mcp body logging is intentionally unchanged (separate hygiene pass).
  const BODY_LOG_SKIP_PATHS = new Set<string>([
    "/api/sync/push",
    "/api/first-wow",
  ]);

  app.use((req, _res, next) => {
    let body = "";
    if (BODY_LOG_SKIP_PATHS.has(req.path)) {
      body = "[skipped]";
    } else if (req.body) {
      body = JSON.stringify(req.body, (key, value) =>
        SENSITIVE_BODY_KEYS.has(key) ? "[redacted]" : value,
      ).slice(0, 300);
    }
    console.error(
      `[${new Date().toISOString()}] ${req.method} ${req.path} body=${body}`,
    );
    next();
  });

  const allowedOrigins = (
    process.env.ALLOWED_ORIGINS || "https://claude.ai,https://claude.com"
  )
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header("Vary", "Origin");
    }
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, mcp-session-id, Authorization",
    );
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    next();
  });
  app.options("/mcp", (_req, res) => res.sendStatus(204));

  // express-rate-limit v8 requires custom keyGenerators to wrap IP fallbacks
  // in `ipKeyGenerator` so IPv6 addresses are subnet-bucketed correctly
  // (otherwise IPv6 clients can bypass limits by varying their /128 bits).
  // See https://express-rate-limit.github.io/ERR_ERL_KEY_GEN_IPV6/.
  const proxyIp = (req: express.Request): string => {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf) return ipKeyGenerator(cf);
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff)
      return ipKeyGenerator(xff.split(",")[0].trim());
    return ipKeyGenerator(req.ip ?? "unknown");
  };

  const makeLimit = (max: number, windowSec = 60) =>
    rateLimit({
      windowMs: windowSec * 1000,
      max,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: proxyIp,
      skip: () => process.env.TAPROOT_DISABLE_RATE_LIMIT === "1",
    });

  // Per-email body-keyed limiter for credential-check endpoints. Stacks IN
  // FRONT of the existing IP-keyed limiter so credential-stuffing across
  // rotating residential proxies hits the email cap before the IP cap.
  // Only counts failed requests (skipSuccessfulRequests: true). Skips on
  // non-POST or empty email — so GET consent page renders and requests missing
  // an email body field fall through to the handler's own 400.
  // Rollback: TAPROOT_DISABLE_RATE_LIMIT=1 disables both this and makeLimit.
  const makeEmailLimit = (max: number, windowSec = 900) =>
    rateLimit({
      windowMs: windowSec * 1000,
      max,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => {
        const email = String(req.body?.email ?? "")
          .toLowerCase()
          .trim();
        return email || "no-email";
      },
      skipSuccessfulRequests: true,
      skip: (req) => {
        if (process.env.TAPROOT_DISABLE_RATE_LIMIT === "1") return true;
        if (req.method !== "POST") return true;
        const email = String(req.body?.email ?? "")
          .toLowerCase()
          .trim();
        return email === "";
      },
    });

  // Email limiter stacked BEFORE IP limiter on credential-check endpoints.
  app.use("/authorize", makeEmailLimit(5));
  app.use("/signin", makeEmailLimit(5));
  app.use("/api/helper/auth/direct", makeEmailLimit(5));

  app.use("/authorize", makeLimit(10));
  app.use("/register", makeLimit(5));
  app.use("/token", makeLimit(20));
  app.use("/revoke", makeLimit(20));
  // /signin and /signin/exchange need independent buckets — exchange is
  // non-interactive and codes naturally expire in 5 min, so it gets a higher
  // cap. Mounting "/signin/exchange" first only narrows the path-match; both
  // middlewares fire on /signin/exchange unless we exclude it from /signin.
  const signinLimit = makeLimit(10);
  const signinExchangeLimit = makeLimit(20);
  app.use("/signin/exchange", signinExchangeLimit);
  app.use("/signin", (req, res, next) => {
    if (req.path.startsWith("/exchange")) return next();
    return signinLimit(req, res, next);
  });
  app.use("/api/helper/pair/redeem", makeLimit(10));
  app.use("/api/helper/auth/direct", makeLimit(10));

  const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
  registerOAuthRoutes(app, baseUrl);
  console.error(
    `[OAuth] Enabled. Sign in with your Taproot account (taproothq.com).`,
  );
  registerSigninRoutes(app, baseUrl);
  console.error(`[Signin] Direct signin enabled at /signin`);

  mountApiRoutes(app);
  console.error(`[API] Onboarding endpoints mounted at /api/*`);

  app.post("/mcp", async (req, res) => {
    if (
      await requireAuth(
        req,
        res,
        `${baseUrl}/.well-known/oauth-protected-resource`,
      )
    )
      return;
    try {
      const { workspaceId } = req as AuthedMcpRequest;
      const mcpBackend = await getBackend(workspaceId, {
        ip: proxyIp(req),
        userAgent: req.headers["user-agent"],
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined as any,
      });
      const server = await createMcpServer(mcpBackend, { workspaceId });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      respondError(res, 500, "mcp_handler_error", err, { logPrefix: "mcp" });
    }
  });

  app.get("/mcp", async (req, res) => {
    if (
      await requireAuth(
        req,
        res,
        `${baseUrl}/.well-known/oauth-protected-resource`,
      )
    )
      return;
    res.status(405).json({ error: "Use POST" });
  });

  app.delete("/mcp", async (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: "taproot",
      version: pkg.version,
    });
  });

  app.listen(port, () => {
    console.error(`Taproot server running at http://localhost:${port}`);
    console.error(`  MCP:    POST /mcp`);
    console.error(`  API:    /api/*`);
    console.error(`  Health: GET  /health`);
  });
}

// Self-invoke when run directly (Railway / cloud deploy)
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("server.js") ||
    process.argv[1].endsWith("server.ts"));

if (isMain) {
  const port = parseInt(process.env.PORT || "3777", 10);
  startServer(port).catch((err) => {
    console.error("Taproot server fatal error:", err);
    process.exit(1);
  });
}
