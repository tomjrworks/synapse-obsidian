#!/usr/bin/env bash
# Stage 1 T11.4 — end-to-end smoke for the helper pull pipeline.
#
# This bash driver only does two things:
#   1. Build the helper binary in debug (`swift build -c debug`)
#   2. Exec the TS worker that does provisioning, server boot, server-side
#      seeding, helper spawn, pull-tick observation, server delete, echo
#      suppression check, 401 sign-out, and full cleanup.
#
# Env (loaded from <repo>/.env if present so manual `set -a` is unneeded):
#   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TAPROOT_KEK   — required
#
# Run: npm run smoke:sync-pull
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
HELPER_DIR="${REPO_ROOT}/helper-mac"

log()  { printf '\033[0;36m[smoke]\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[0;32m[ ok  ]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[0;31m[fail ]\033[0m %s\n' "$*" >&2; }

# ─── Load .env (no dotenv loader in the repo; smoke-cloud-suite has the same need) ───
if [[ -f "${REPO_ROOT}/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    . "${REPO_ROOT}/.env"
    set +a
    ok ".env loaded from ${REPO_ROOT}/.env"
fi

# ─── Pre-flight ────────────────────────────────────────────────────────────
for v in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY TAPROOT_KEK; do
    if [[ -z "${!v:-}" ]]; then
        err "${v} is not set (required). Add it to ${REPO_ROOT}/.env or export it."
        exit 1
    fi
done
ok "env vars present"

if [[ ! -d "${HELPER_DIR}" ]]; then
    err "helper-mac dir missing at ${HELPER_DIR}"
    exit 1
fi

# ─── Build the helper binary ───────────────────────────────────────────────
log "Building helper-mac in debug…"
if ! ( cd "${HELPER_DIR}" && swift build -c debug >&2 ); then
    err "swift build failed"
    exit 1
fi

BINARY_PATH="${HELPER_DIR}/.build/debug/TaprootHelper"
if [[ ! -x "${BINARY_PATH}" ]]; then
    ARCH_BIN="$(/bin/ls -1 "${HELPER_DIR}/.build/"*-apple-macosx/debug/TaprootHelper 2>/dev/null | head -1 || true)"
    if [[ -n "${ARCH_BIN}" && -x "${ARCH_BIN}" ]]; then
        BINARY_PATH="${ARCH_BIN}"
    else
        err "TaprootHelper binary not found after build"
        exit 1
    fi
fi
ok "binary at ${BINARY_PATH}"
export TAPROOT_HELPER_BINARY="${BINARY_PATH}"

# ─── Exec the TS worker ────────────────────────────────────────────────────
cd "${REPO_ROOT}"
log "Running scripts/smoke-sync-pull.ts…"
exec npx tsx "${SCRIPT_DIR}/smoke-sync-pull.ts"
