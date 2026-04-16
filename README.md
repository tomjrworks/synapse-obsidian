# Synapse

**The nervous system between your AI and your notes.**

MCP server that connects any AI to your Obsidian vault. Works with Claude, ChatGPT, Cursor, Windsurf, and any MCP-compatible client. Save articles from your phone, ask questions across your notes, build a compounding knowledge base.

## 30-Second Setup

### Claude Desktop

1. Open config: **Mac** `~/Library/Application Support/Claude/claude_desktop_config.json` | **Windows** `%APPDATA%\Claude\claude_desktop_config.json`
2. Add Synapse to the `mcpServers` object:

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

3. Restart Claude Desktop. Synapse tools appear automatically.

### Claude Code

Add to `.claude/.mcp.json` in your home directory:

```json
{
  "mcpServers": {
    "synapse": {
      "command": "npx",
      "args": ["-y", "synapse-obsidian", "/path/to/your/vault"]
    }
  }
}
```

### Claude.ai / ChatGPT / Any remote AI

Run Synapse locally and expose it with a free tunnel:

```bash
# Terminal 1: Start Synapse
npx synapse-obsidian /path/to/vault --http --port 3777

# Terminal 2: Expose it (free, no account needed)
npx cloudflared tunnel --url http://localhost:3777
```

Copy the tunnel URL. Add `https://your-tunnel-url.trycloudflare.com/mcp` as a custom MCP integration in your AI client.

## Getting Started

Once connected, say:

> **"Help me get started with Synapse"**

Synapse scans your vault and gives you three options:

- **Use my existing vault** — Detects your folder structure, wikilinks, naming conventions. Nothing moved or overwritten. Synapse adapts to you.
- **Set up a knowledge base** — Creates a structured wiki: `raw/` for sources, `wiki/` for compiled knowledge. Best for a focused research topic.
- **Custom** — You tell Synapse how you want things organized.

It also asks what you'll use the vault for (research, business, academic, life OS) so it can tailor the experience.

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
| `synapse_setup`     | Onboarding — scans vault, presents options, configures Synapse |
| `synapse_configure` | Saves your vault preferences                                   |
| `synapse_save`      | Save content from a URL or pasted text                         |
| `synapse_status`    | Full vault overview with suggested actions                     |
| `synapse_ingest`    | Process a source into organized pages                          |
| `synapse_compile`   | Find and process all unprocessed sources                       |
| `synapse_query`     | Research a question across your knowledge base                 |
| `synapse_lint`      | Health-check for broken links, orphans, gaps                   |
| `synapse_init`      | Scaffold a new knowledge base from scratch                     |
| `vault_read`        | Read any file                                                  |
| `vault_write`       | Create or update any file                                      |
| `vault_list`        | List files in vault or subdirectory                            |
| `vault_search`      | Full-text search                                               |
| `vault_stats`       | File counts and structure                                      |
| `vault_frontmatter` | Read YAML metadata from a file                                 |

## How It Works

Synapse is an [MCP server](https://modelcontextprotocol.io) — an open protocol for connecting AI to tools and data. It gives your AI read/write access to your vault (and nothing else — sandboxed to the vault directory).

- **Stdio** (default) — For desktop AI apps (Claude Desktop, etc.)
- **HTTP** (`--http`) — For browser-based AI (Claude.ai, ChatGPT, etc.) via tunnel
- **Cloud** (`--cloud`) — Hosted mode with Google Drive OAuth (coming soon)

Your vault is just a folder of markdown files. Synapse doesn't need Obsidian to be running — it works with any folder.

## Requirements

- [Node.js](https://nodejs.org) 18+ (check with `node -v`)
- An Obsidian vault or any folder of markdown files
- Any MCP-compatible AI client

## License

MIT — [MainLoop Systems](https://mainloopsystems.com)
