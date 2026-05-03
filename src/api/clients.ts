import { Router } from "express";
import { supabaseService } from "./supabase.js";
import {
  requireSupabaseAuth,
  requireWorkspace,
  asyncHandler,
  type AuthedWorkspaceRequest,
} from "./middleware.js";
import { patchWorkspaceSettings } from "./workspace.js";
import { respondError } from "./respond-error.js";

type ClientPath = "url-paste" | "json-config" | "cli-command";

type ClientDef = {
  id: string;
  label: string;
  path: ClientPath;
  instructions_md: string;
  screenshot_url: string;
};

const CLIENTS: ClientDef[] = [
  {
    id: "claude-ai",
    label: "claude.ai",
    path: "url-paste",
    instructions_md:
      "Open claude.ai → Settings → Integrations → Add custom integration. Paste the URL below.",
    screenshot_url: "/screenshots/connect/claude-ai.png",
  },
  {
    id: "cowork",
    label: "Cowork",
    path: "url-paste",
    instructions_md:
      "Open Cowork → Settings → Integrations → Add MCP server. Paste the URL below.",
    screenshot_url: "/screenshots/connect/cowork.png",
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    path: "json-config",
    instructions_md:
      "Open `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac) or `%APPDATA%\\Claude\\claude_desktop_config.json` (Windows). Merge the JSON below into `mcpServers`.",
    screenshot_url: "/screenshots/connect/claude-desktop.png",
  },
  {
    id: "claude-code",
    label: "Claude Code",
    path: "cli-command",
    instructions_md:
      "Run the command below in your terminal. Claude Code will register Taproot as a remote MCP server.",
    screenshot_url: "/screenshots/connect/claude-code.png",
  },
  {
    id: "cursor",
    label: "Cursor",
    path: "json-config",
    instructions_md:
      "Open Cursor → Settings → MCP. Add the JSON below to your MCP config.",
    screenshot_url: "/screenshots/connect/cursor.png",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    path: "json-config",
    instructions_md:
      "Open Windsurf → Settings → MCP Servers. Add the JSON below.",
    screenshot_url: "/screenshots/connect/windsurf.png",
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    path: "url-paste",
    instructions_md:
      "Open ChatGPT → Settings → Connectors → Add MCP. Paste the URL below.",
    screenshot_url: "/screenshots/connect/chatgpt.png",
  },
  {
    id: "microsoft-copilot",
    label: "Microsoft Copilot",
    path: "url-paste",
    instructions_md:
      "Open Microsoft 365 Copilot → Settings → Connectors → Add MCP. Paste the URL below.",
    screenshot_url: "/screenshots/connect/microsoft-copilot.png",
  },
];

const ALLOWED_CLIENT_IDS = new Set(CLIENTS.map((c) => c.id));

function publicMcpUrl(): string {
  return (
    process.env.TAPROOT_PUBLIC_MCP_URL ?? "https://connect.taproothq.com/mcp"
  );
}

function buildPayload(client: ClientDef, mcpUrl: string): string {
  switch (client.path) {
    case "url-paste":
      return mcpUrl;
    case "json-config":
      return JSON.stringify(
        { mcpServers: { taproot: { url: mcpUrl } } },
        null,
        2,
      );
    case "cli-command":
      return `claude mcp add taproot ${mcpUrl}`;
  }
}

export function clientsRouter(): Router {
  const router = Router();

  router.get(
    "/clients/setup-info",
    requireSupabaseAuth,
    requireWorkspace,
    asyncHandler(async (req, res) => {
      const { membership } = req as AuthedWorkspaceRequest;

      const mcpUrl = publicMcpUrl();
      const entries = CLIENTS.map((c) => ({
        id: c.id,
        label: c.label,
        path: c.path,
        payload: buildPayload(c, mcpUrl),
        instructions_md: c.instructions_md,
        screenshot_url: c.screenshot_url,
      }));

      res.json({
        workspace_id: membership.workspaceId,
        mcp_url: mcpUrl,
        clients: entries,
      });
    }),
  );

  router.post(
    "/clients/:client_id/connected",
    requireSupabaseAuth,
    requireWorkspace,
    asyncHandler(async (req, res) => {
      const clientIdRaw = req.params.client_id;
      const clientId =
        typeof clientIdRaw === "string" ? clientIdRaw : clientIdRaw?.[0];
      if (!clientId || !ALLOWED_CLIENT_IDS.has(clientId)) {
        res.status(400).json({
          error: "unknown_client",
          allowed: [...ALLOWED_CLIENT_IDS],
        });
        return;
      }

      const { membership } = req as AuthedWorkspaceRequest;
      const sb = supabaseService();

      const current = Array.isArray(membership.settings.connected_clients)
        ? membership.settings.connected_clients
        : [];
      const next = current.includes(clientId)
        ? current
        : [...current, clientId];

      const { settings, error } = await patchWorkspaceSettings(
        sb,
        membership.workspaceId,
        { connected_clients: next },
      );
      if (error) {
        respondError(res, 500, "update_failed", error, {
          logPrefix: "clients",
        });
        return;
      }

      res.json({
        workspace_id: membership.workspaceId,
        connected_clients: settings.connected_clients,
      });
    }),
  );

  return router;
}
