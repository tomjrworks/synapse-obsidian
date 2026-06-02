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

echo "→ Deploying ${COMMIT} (${BRANCH})${DIRTY}"
echo "→ Stamping DEPLOY_COMMIT=${COMMIT} on Railway (no redeploy)"
railway variables --set "DEPLOY_COMMIT=${COMMIT}" --skip-deploys
echo "→ railway up"
railway up
echo ""
echo "→ Verify the new code is live:"
echo "    curl -s https://connect.taproothq.com/health"
echo "    expect  \"commit\":\"${COMMIT}\""
