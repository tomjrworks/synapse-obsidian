#!/bin/bash
# Start Synapse MCP server + Cloudflare tunnel
# Writes the tunnel URL to ~/.synapse-url for reference

# Start Synapse HTTP server
node /Users/miloman/Documents/obsidian-brain/dist/index.js "/Users/miloman/Desktop/vault/Tom's Vault" --http --port 3777 &
SYNAPSE_PID=$!

# Wait for server to be ready
sleep 2

# Start Cloudflare tunnel and capture the URL
npx cloudflared tunnel --url http://localhost:3777 2>&1 | while read -r line; do
  echo "$line"
  if echo "$line" | grep -q "https://.*trycloudflare.com"; then
    URL=$(echo "$line" | grep -o 'https://[^ ]*trycloudflare.com')
    echo "$URL/mcp" > ~/.synapse-url
    echo ""
    echo "================================================"
    echo "Synapse MCP URL: $URL/mcp"
    echo "Add this to Claude.ai > Settings > Integrations"
    echo "================================================"
    echo ""
  fi
done

# Cleanup on exit
kill $SYNAPSE_PID 2>/dev/null
