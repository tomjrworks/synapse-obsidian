# Synapse

**MCP server that turns your Obsidian vault into an AI-powered knowledge base.**

The [Karpathy pattern](https://x.com/karpathy/status/1907503816696451529) — packaged as an MCP server anyone can install.

Synapse connects Claude (Desktop, claude.ai, or Claude Code) to your local Obsidian vault. No copy-pasting. No terminal required after setup. Your AI reads, writes, searches, and maintains a structured wiki inside your vault.

## What It Does

| Tool                | Description                                            |
| ------------------- | ------------------------------------------------------ |
| `vault_read`        | Read any file from your vault                          |
| `vault_write`       | Create or update files (creates folders automatically) |
| `vault_list`        | List markdown files in vault or subdirectory           |
| `vault_search`      | Full-text search across all vault files                |
| `vault_stats`       | Vault statistics and knowledge base status             |
| `vault_frontmatter` | Read YAML frontmatter metadata from any file           |
| `kb_init`           | Initialize the full knowledge base structure           |
| `kb_ingest`         | Process a raw source into wiki pages                   |
| `kb_compile`        | Find all unprocessed sources and compile them          |
| `kb_query`          | Research a question across your wiki                   |
| `kb_lint`           | Health-check: broken links, orphans, stale content     |

## Quick Start

### Option A: Claude Desktop (Recommended)

1. Open your Claude Desktop config:
   - **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

2. Add Synapse:

```json
{
  "mcpServers": {
    "synapse": {
      "command": "npx",
      "args": ["-y", "synapse-mcp", "/path/to/your/obsidian-vault"]
    }
  }
}
```

3. Restart Claude Desktop. Synapse tools appear automatically.

### Option B: Claude Code

Add to `.claude/.mcp.json` in your home directory or project:

```json
{
  "mcpServers": {
    "synapse": {
      "command": "npx",
      "args": ["-y", "synapse-mcp", "/path/to/your/obsidian-vault"]
    }
  }
}
```

### Option C: Claude.ai (Remote MCP)

Run Synapse in HTTP mode and expose it:

```bash
# Start the HTTP server
npx synapse-mcp /path/to/vault --http --port 3777

# In another terminal, expose with a tunnel (pick one):
npx cloudflared tunnel --url http://localhost:3777
# or: ngrok http 3777
```

Then in Claude.ai: **Settings > Integrations > Add MCP Server** and enter the tunnel URL + `/mcp` path.

### Option D: Local Install

```bash
npm install -g synapse-mcp

# Stdio mode (for Claude Desktop/Code)
synapse /path/to/vault

# HTTP mode (for Claude.ai)
synapse /path/to/vault --http --port 3777
```

## Your First Knowledge Base

Once connected, just tell Claude:

> "Initialize a knowledge base about [your topic]"

Claude will call `kb_init` and set up the full structure:

```
your-vault/
├── raw/
│   ├── articles/     ← Drop articles here
│   ├── papers/       ← PDFs converted to markdown
│   └── ...
├── wiki/
│   ├── index.md      ← AI-maintained master index
│   ├── log.md        ← Activity log
│   ├── concepts/     ← One page per concept
│   ├── entities/     ← People, orgs, tools
│   ├── sources/      ← Summaries of raw sources
│   ├── syntheses/    ← Cross-cutting analyses
│   └── outputs/      ← Answers to your questions
├── templates/
└── CLAUDE.md          ← AI schema (auto-generated)
```

### The Workflow

1. **Add sources** — Drop articles into `raw/articles/` (use [Obsidian Web Clipper](https://obsidian.md/clipper) for one-click saving)
2. **Compile** — Tell Claude: "Compile my knowledge base" → it processes all new sources
3. **Ask questions** — "What do my sources say about X?" → cited answer, saved back to wiki
4. **Health check** — "Lint my wiki" → finds broken links, orphans, gaps

Every answer gets filed back into the wiki. The knowledge compounds.

## How It Works

Synapse is a standard [MCP server](https://modelcontextprotocol.io). It exposes tools that let Claude interact with your local filesystem (scoped to your vault only — it cannot access files outside).

- **Stdio transport** (default) — Claude Desktop and Claude Code pipe messages through stdin/stdout
- **HTTP transport** (`--http`) — Runs an Express server implementing Streamable HTTP for remote MCP connections

All file operations are sandboxed to the vault directory. Path traversal is blocked.

## Environment Variables

| Variable             | Description                                      |
| -------------------- | ------------------------------------------------ |
| `SYNAPSE_VAULT_PATH` | Default vault path (alternative to CLI argument) |

## Requirements

- Node.js 18+
- An Obsidian vault (or any folder — Synapse works with plain markdown)
- Claude Desktop, Claude.ai, or Claude Code

## License

MIT — [MainLoop Systems](https://mainloopsystems.com)
