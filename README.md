# Synapse

**MCP server that connects Claude to your Obsidian vault.**

Inspired by [Karpathy's LLM knowledge base pattern](https://x.com/karpathy/status/1907503816696451529). Works with your existing vault or sets up a new one. Save articles from your phone, ask questions across your notes, build a compounding knowledge base — all through Claude.

## 30-Second Setup

### Claude Desktop

1. Open config: **Mac** `~/Library/Application Support/Claude/claude_desktop_config.json` | **Windows** `%APPDATA%\Claude\claude_desktop_config.json`
2. Add:

```json
{
  "mcpServers": {
    "synapse": {
      "command": "npx",
      "args": ["-y", "synapse-obsidian", "/path/to/your/obsidian-vault"]
    }
  }
}
```

3. Restart Claude Desktop.

### Claude Code

```bash
# Add to your MCP config
echo '{"mcpServers":{"synapse":{"command":"npx","args":["-y","synapse-obsidian","/path/to/your/vault"]}}}' > .claude/.mcp.json
```

### Claude.ai (remote access)

```bash
# Terminal 1: Start Synapse
npx synapse-obsidian /path/to/vault --http --port 3777

# Terminal 2: Expose it (free, no account needed)
npx cloudflared tunnel --url http://localhost:3777
```

Copy the tunnel URL. In Claude.ai: **Settings > Connectors > Add > Custom** — paste `https://your-tunnel-url.trycloudflare.com/mcp`

## Getting Started

Once connected, say:

> **"Help me get started with Synapse"**

Synapse scans your vault and gives you three options:

- **Use my existing vault** — Detects your folder structure, CLAUDE.md, wikilinks, naming conventions. No files created or moved. Synapse adapts to you.
- **Set up a knowledge base** — Creates the full Karpathy structure: `raw/` for sources, `wiki/` for compiled knowledge, `CLAUDE.md` schema. Best for a focused topic.
- **Custom** — You tell Synapse how you want things organized.

It also asks what you'll use the vault for (research, business, academic, life OS) so Claude knows how to help.

## What You Can Do

### Save anything, from anywhere

> "Save this article: https://example.com/interesting-post"

Fetches the page, converts to markdown, saves to your vault. Works from your phone.

### Ask questions across your notes

> "What do my notes say about pricing strategy?"

Searches your vault, reads relevant files, synthesizes a cited answer.

### Build a compounding wiki

> "Process all new articles in my vault"

Turns raw sources into summaries, concept pages, entity pages — all cross-linked with wikilinks. Every answer feeds back into the knowledge base.

### Health check your notes

> "Run a health check on my vault"

Finds broken links, orphan pages, missing frontmatter, stale content. Fixes what it can.

## All Tools

| Tool                | What it does                                                   |
| ------------------- | -------------------------------------------------------------- |
| `kb_setup`          | Onboarding — scans vault, presents options, configures Synapse |
| `kb_configure`      | Saves your vault preferences                                   |
| `kb_save`           | Save content from a URL or pasted text                         |
| `kb_status`         | Full vault overview with suggested actions                     |
| `kb_ingest`         | Process a source into wiki pages                               |
| `kb_compile`        | Find and process all unprocessed sources                       |
| `kb_query`          | Research a question across your wiki                           |
| `kb_lint`           | Health-check for broken links, orphans, gaps                   |
| `kb_init`           | Scaffold a new Karpathy-style knowledge base                   |
| `vault_read`        | Read any file                                                  |
| `vault_write`       | Create or update any file                                      |
| `vault_list`        | List files in vault or subdirectory                            |
| `vault_search`      | Full-text search                                               |
| `vault_stats`       | File counts and structure                                      |
| `vault_frontmatter` | Read YAML metadata from a file                                 |

## How It Works

Synapse is an [MCP server](https://modelcontextprotocol.io). It gives Claude read/write access to your Obsidian vault (and nothing else — sandboxed to the vault directory).

- **Stdio** (default) — For Claude Desktop and Claude Code
- **HTTP** (`--http`) — For Claude.ai via tunnel
- **Cloud** (`--cloud`) — Hosted mode with Google Drive OAuth (coming soon)

Your vault is just a folder of markdown files. Synapse doesn't need Obsidian to be running.

## Requirements

- Node.js 18+
- An Obsidian vault (or any markdown folder)
- Claude Desktop, Claude Code, or Claude.ai

## License

MIT — [MainLoop Systems](https://mainloopsystems.com)
