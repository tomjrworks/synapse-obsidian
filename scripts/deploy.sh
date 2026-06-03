#!/usr/bin/env bash
# Deploy PRODUCT (obsidian-brain) to Railway with the running git commit stamped
# into DEPLOY_COMMIT, so `GET /health` reports exactly which code is live.
# Use this instead of a bare `railway up` — it closes the "what's deployed?" gap
# (railway up strips .git, so the container can't derive the commit itself).
set -euo pipefail

COMMIT="$(git rev-parse --short=12 HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
DIRTY=""
if ! git diff --quiet || ! git diff --cached --quiet; then
  DIRTY="  ⚠️ UNCOMMITTED CHANGES — deploying a dirty tree"
fi

# MIGRATION GATE (added 2026-06-03 after the extracted_tokens incident: deploying
# Pass 3 code that writes vault_files.extracted_tokens WITHOUT applying migration
# 0030 broke /api/sync/push for all users). Code deploy != DB migration. Block if
# any local migration is not yet applied to the linked remote. Fail-SAFE: if the
# check itself can't run (auth/network/CLI), warn but do NOT block the deploy.
echo "→ Checking for unapplied migrations (supabase migration list --linked)…"
if MIGRATION_LIST="$(supabase migration list --linked 2>/dev/null)"; then
  # Rows are "Local | Remote | Time". A local-only (pending) row has a numeric
  # Local field and an EMPTY Remote field.
  PENDING="$(printf '%s\n' "$MIGRATION_LIST" | awk -F'|' '{ l=$1; r=$2; gsub(/[ \t]/,"",l); gsub(/[ \t]/,"",r); if (l ~ /^[0-9]+$/ && r=="") print l }')"
  if [ -n "$PENDING" ]; then
    echo "✋ DEPLOY BLOCKED — local migrations NOT applied to prod:"
    printf '%s\n' "$PENDING" | sed 's/^/      /'
    echo "   Run 'supabase db push' first, then re-run deploy. (See CLAUDE.md MIGRATION GATE.)"
    echo "   Code that references a not-yet-created column breaks sync for all users."
    exit 1
  fi
  echo "  ✓ no unapplied migrations"
else
  echo "  ⚠️ could not run migration check (auth/network/CLI) — VERIFY MANUALLY before trusting this deploy:"
  echo "       supabase migration list --linked   # no local-only rows allowed"
fi

echo "→ Deploying ${COMMIT} (${BRANCH})${DIRTY}"
echo "→ Stamping DEPLOY_COMMIT=${COMMIT} on Railway (no redeploy)"
railway variables --set "DEPLOY_COMMIT=${COMMIT}" --skip-deploys
echo "→ railway up"
railway up
echo ""
echo "→ Verify the new code is live:"
echo "    curl -s https://connect.taproothq.com/health"
echo "    expect  \"commit\":\"${COMMIT}\""
