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
  path_type: ClientPath;
  instructions_md: string;
  screenshot_url: string;
};

const CLIENTS: ClientDef[] = [
  {
    id: "claude-ai",
    label: "claude.ai (web)",
    path_type: "url-paste",
    instructions_md:
      "Paste this URL in claude.ai → Settings → Custom Integrations → Add custom integration.",
    screenshot_url: "/screenshots/connect/claude-ai.png",
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    path_type: "json-config",
    instructions_md:
      "Add this to ~/Library/Application Support/Claude/claude_desktop_config.json. Restart Claude Desktop.",
    screenshot_url: "/screenshots/connect/claude-desktop.png",
  },
  {
    id: "claude-code",
    label: "Claude Code",
    path_type: "cli-command",
    instructions_md: "Run this command in your terminal.",
    screenshot_url: "/screenshots/connect/claude-code.png",
  },
  {
    id: "cursor",
    label: "Cursor",
    path_type: "json-config",
    instructions_md:
      "Add this to .cursor/mcp.json in your project root, or globally at ~/.cursor/mcp.json. Restart Cursor.",
    screenshot_url: "/screenshots/connect/cursor.png",
  },
  {
    id: "windsurf",
    label: "Windsurf (Cascade)",
    path_type: "json-config",
    instructions_md: "Add this to Cascade's MCP config. Restart Windsurf.",
    screenshot_url: "/screenshots/connect/windsurf.png",
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    path_type: "url-paste",
    instructions_md:
      "Open ChatGPT → Custom GPTs → Add connector → paste this URL.",
    screenshot_url: "/screenshots/connect/chatgpt.png",
  },
  {
    id: "copilot-vscode",
    label: "GitHub Copilot (VS Code)",
    path_type: "json-config",
    instructions_md:
      "Add this to VS Code settings.json (Cmd+Shift+P → Preferences: Open User Settings (JSON)). Reload window.",
    screenshot_url: "/screenshots/connect/copilot-vscode.png",
  },
  {
    id: "cowork",
    label: "Cowork",
    path_type: "url-paste",
    instructions_md: "In Cowork, open Connectors → Add → paste this URL.",
    screenshot_url: "/screenshots/connect/cowork.png",
  },
];

const ALLOWED_CLIENT_IDS = new Set(CLIENTS.map((c) => c.id));

function publicMcpUrl(): string {
  return (
    process.env.TAPROOT_PUBLIC_MCP_URL ?? "https://connect.taproothq.com/mcp"
  );
}

function buildPayload(client: ClientDef, mcpUrl: string): string {
  switch (client.path_type) {
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
        path_type: c.path_type,
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
