#!/usr/bin/env bash
# Bundle 6 — flip 4 Supabase auth config fields.
# Reads PAT, hCaptcha secret, Resend API key from env (.env.local).
# Snapshots current config to vault before/after, never echoes secrets.

set -euo pipefail

PROJECT_REF="bbkvpmqrjobkquxteoes"
API_BASE="https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth"
SNAPSHOT_DIR="$HOME/Desktop/vault/Tom's Vault/projects/taproot/snapshots"

# Required env (set before invoking, e.g. via `set -a && source .env.local && set +a`)
: "${SUPABASE_MGMT_PAT:?missing SUPABASE_MGMT_PAT — see ~/.claude/plans/verdant-pruning-cipher.md pre-flight 1}"
: "${HCAPTCHA_SECRET:?missing HCAPTCHA_SECRET — see pre-flight 2}"
: "${RESEND_API_KEY:?missing RESEND_API_KEY — already in agency/taproothq/.env.local, source it first}"

mkdir -p "$SNAPSHOT_DIR"
TS=$(date -u +%Y-%m-%dT%H-%M-%SZ)

echo "→ Pre-flight: GET current config..."
PRE=$(curl -fsS -H "Authorization: Bearer ${SUPABASE_MGMT_PAT}" "$API_BASE")
echo "$PRE" | jq '.' > "$SNAPSHOT_DIR/auth-config-pre-${TS}.json"
echo "  snapshot: $SNAPSHOT_DIR/auth-config-pre-${TS}.json"

# Sanity: refuse to PATCH if any auth hook is enabled (known Supabase bug
# supabase/supabase#36861 → PATCH 400s on hook-configured projects).
HOOKS_ENABLED=$(echo "$PRE" | jq '[
  .hook_password_verification_attempt_enabled,
  .hook_send_email_enabled,
  .hook_send_sms_enabled,
  .hook_before_user_created_enabled,
  .hook_after_user_created_enabled
] | map(select(. == true)) | length')
if [[ "$HOOKS_ENABLED" -gt 0 ]]; then
  echo "✗ Auth hooks are configured ($HOOKS_ENABLED enabled) — Supabase bug #36861 would block this PATCH. Disable hooks first or do the flip manually in dashboard."
  exit 1
fi
echo "  ✓ no auth hooks enabled"

echo "→ PATCH config..."
curl -fsS -X PATCH \
  -H "Authorization: Bearer ${SUPABASE_MGMT_PAT}" \
  -H "Content-Type: application/json" \
  "$API_BASE" \
  -d @- <<EOF
{
  "mailer_autoconfirm": false,
  "mailer_allow_unverified_email_sign_ins": false,
  "password_min_length": 10,
  "security_captcha_enabled": true,
  "security_captcha_provider": "hcaptcha",
  "security_captcha_secret": "${HCAPTCHA_SECRET}",
  "smtp_admin_email": "tom@taproothq.com",
  "smtp_host": "smtp.resend.com",
  "smtp_port": "587",
  "smtp_user": "resend",
  "smtp_pass": "${RESEND_API_KEY}",
  "smtp_sender_name": "Taproot",
  "smtp_max_frequency": 60
}
EOF
echo "  ✓ PATCH ok"

echo "→ Verify: GET post-PATCH config..."
POST=$(curl -fsS -H "Authorization: Bearer ${SUPABASE_MGMT_PAT}" "$API_BASE")
echo "$POST" | jq '.' > "$SNAPSHOT_DIR/auth-config-post-${TS}.json"

echo
echo "Diff (selected fields only — secrets not echoed):"
echo "$POST" | jq '{
  mailer_autoconfirm,
  mailer_allow_unverified_email_sign_ins,
  password_min_length,
  security_captcha_enabled,
  security_captcha_provider,
  smtp_admin_email,
  smtp_host,
  smtp_port,
  smtp_user,
  smtp_sender_name,
  smtp_max_frequency
}'
echo
echo "Done. Pre/post snapshots in $SNAPSHOT_DIR"
