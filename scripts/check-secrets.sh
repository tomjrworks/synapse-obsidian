#!/usr/bin/env bash
# Pre-commit guard: block commits that look like they leak secrets to logs.
#
# Tripwires:
#   1. console.* call (log/error/warn/info/debug) containing one of:
#      kek, dek, wrapped_dek, TAPROOT_KEK, service_role, plaintext
#   2. 64-char lowercase hex string literal (KEK shape) added inline.
#
# Scope: staged TypeScript/JavaScript files only.
# Exclusions: this script itself + node_modules.
# Override: `git commit --no-verify` (use sparingly).

set -e

staged=$(
  git diff --cached --name-only --diff-filter=ACM \
    | grep -E '\.(ts|tsx|js|jsx|cjs|mjs)$' \
    | grep -v -E '^(scripts/check-secrets\.sh|node_modules/)' \
    || true
)

if [[ -z "$staged" ]]; then
  exit 0
fi

violations=()

while IFS= read -r file; do
  [[ -z "$file" ]] && continue

  added=$(git diff --cached --no-color -U0 -- "$file" | grep -E '^\+[^+]' || true)
  [[ -z "$added" ]] && continue

  while IFS= read -r line; do
    snippet=$(echo "$line" | sed 's/^+//' | head -c 120)

    if echo "$line" | grep -iqE 'console\.(log|error|warn|info|debug)\b.*\b(kek|dek|wrapped_dek|TAPROOT_KEK|service_role|plaintext)'; then
      violations+=("${file}: console call references a secret keyword")
      violations+=("    > ${snippet}")
    fi

    if echo "$line" | grep -qE "(\"[a-f0-9]{64}\"|'[a-f0-9]{64}')"; then
      violations+=("${file}: 64-char hex literal added (KEK shape)")
      violations+=("    > ${snippet}")
    fi
  done <<< "$added"
done <<< "$staged"

if [[ ${#violations[@]} -gt 0 ]]; then
  printf "\n[pre-commit] secret leak guard tripped\n\n"
  for v in "${violations[@]}"; do
    printf "  %s\n" "$v"
  done
  printf "\nSensitive keywords (KEK / DEK / wrapped_dek / TAPROOT_KEK / service_role /\n"
  printf "plaintext) appear inside a console.* call, OR a 64-char hex literal was\n"
  printf "added inline. These are the most common ways secrets leak to logs.\n\n"
  printf "If this is a genuine false positive, override with:\n"
  printf "  git commit --no-verify\n\n"
  exit 1
fi
