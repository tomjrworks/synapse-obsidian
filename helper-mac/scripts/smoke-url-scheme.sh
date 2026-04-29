#!/usr/bin/env bash
# T11.1 dev-only smoke for the `taproot://` URL scheme.
#
# Wraps the SwiftPM-built helper binary in a minimal `.app` bundle, registers
# it with Launch Services, fires `open "taproot://auth?..."`, verifies the
# helper picked it up by checking for a Keychain entry, then tears down
# everything (process, lsregister, .app dir, keychain entry).
#
# Idempotent: re-running on partial state is safe. Pass `--cleanup-only` to
# just run teardown (useful when a prior run aborted).
#
# Run from anywhere; uses absolute paths.
#
# Smoke covers what the XCTests can't:
#   - applicationWillFinishLaunching's NSAppleEventManager registration
#   - handleGetURLEvent's AEKeyword(keyDirectObject) extraction
#   - end-to-end Launch Services routing of taproot:// to the helper
#
# NOT covered (deferred to T11.10): production-bundle code signing,
# notarization, Developer ID identity. This is dev-only.

set -uo pipefail

# ─── Configuration ──────────────────────────────────────────────────────────
HELPER_REPO="$HOME/Documents/obsidian-brain/helper-mac"
BINARY_PATH="$HELPER_REPO/.build/arm64-apple-macosx/debug/TaprootHelper"
BUNDLE="$HOME/Applications/TaprootHelperSmoke.app"
LSREG="/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister"
KEYCHAIN_SERVICE="com.taproot.helper"
SMOKE_BUNDLE_ID="com.taproot.helper.smoke"
LOG_FILE="/tmp/taproot-smoke.log"

# Set during smoke(), used by teardown(). Empty until populated.
TEST_UUID=""
TEST_BEARER=""
HELPER_PID=""

# ─── Logging helpers ────────────────────────────────────────────────────────
log()  { printf '\033[0;36m[smoke]\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[0;32m[ ok  ]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[0;33m[warn ]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[0;31m[fail ]\033[0m %s\n' "$*" >&2; }

# ─── Teardown — runs on EXIT, must be idempotent ────────────────────────────
teardown() {
    log "Teardown starting…"

    # 1. Kill helper process (graceful → -9 → pkill by full path)
    if [[ -n "${HELPER_PID:-}" ]] && kill -0 "$HELPER_PID" 2>/dev/null; then
        kill "$HELPER_PID" 2>/dev/null || true
        sleep 1
        kill -9 "$HELPER_PID" 2>/dev/null || true
    fi
    pkill -f "TaprootHelperSmoke.app/Contents/MacOS/TaprootHelper" 2>/dev/null || true

    # 2. Unregister bundle from Launch Services (must precede rm to avoid ghost)
    if [[ -d "$BUNDLE" ]]; then
        "$LSREG" -u "$BUNDLE" 2>/dev/null || true
    fi

    # 3. Delete the bundle
    rm -rf "$BUNDLE" 2>/dev/null || true

    # 4. Delete test keychain entry (exit 44 = errSecItemNotFound, fine)
    if [[ -n "${TEST_UUID:-}" ]]; then
        security delete-generic-password \
            -s "$KEYCHAIN_SERVICE" \
            -a "workspace.${TEST_UUID}.bearer" \
            >/dev/null 2>&1 || true
    fi

    # 5. GC Launch Services DB to compact ghost rows from prior aborted runs
    "$LSREG" -gc 2>/dev/null || true

    # 6. Final 4-check verification
    log "Teardown verification:"
    local clean=true

    if "$LSREG" -dump 2>/dev/null | grep -q "$SMOKE_BUNDLE_ID"; then
        err "  ORPHAN: Launch Services still knows about $SMOKE_BUNDLE_ID"
        clean=false
    else
        ok "  Launch Services clean"
    fi

    if [[ -d "$BUNDLE" ]]; then
        err "  ORPHAN: bundle still on disk at $BUNDLE"
        clean=false
    else
        ok "  Disk clean"
    fi

    if pgrep -f "TaprootHelperSmoke.app/Contents/MacOS/TaprootHelper" >/dev/null 2>&1; then
        err "  ORPHAN: smoke helper process still running"
        clean=false
    else
        ok "  Process clean"
    fi

    if [[ -n "${TEST_UUID:-}" ]] && security find-generic-password \
            -s "$KEYCHAIN_SERVICE" \
            -a "workspace.${TEST_UUID}.bearer" \
            >/dev/null 2>&1; then
        err "  ORPHAN: keychain entry remains for workspace ${TEST_UUID}"
        clean=false
    else
        ok "  Keychain clean"
    fi

    if $clean; then
        ok "Teardown complete — no orphan state"
    else
        err "Teardown FAILED — manual cleanup needed"
        return 1
    fi
}

# ─── Pre-flight ─────────────────────────────────────────────────────────────
preflight() {
    log "Pre-flight checks…"

    if [[ ! -x "$BINARY_PATH" ]]; then
        err "Binary not found or not executable: $BINARY_PATH"
        err "Run \`swift build\` in $HELPER_REPO first."
        return 1
    fi
    ok "Binary present"

    if [[ ! -x "$LSREG" ]]; then
        err "lsregister missing at $LSREG (macOS internals moved?)"
        return 1
    fi
    ok "lsregister present"

    if [[ ! -d "$HOME/Applications" ]]; then
        log "~/Applications missing; creating"
        mkdir -p "$HOME/Applications"
    fi
    ok "~/Applications ready"

    # Check for stale state
    local stale=0
    if pgrep -f "TaprootHelperSmoke.app/Contents/MacOS/TaprootHelper" >/dev/null 2>&1; then
        warn "Stale smoke helper process detected"
        stale=1
    fi
    if [[ -d "$BUNDLE" ]]; then
        warn "Stale bundle exists at $BUNDLE"
        stale=1
    fi
    if "$LSREG" -dump 2>/dev/null | grep -q "$SMOKE_BUNDLE_ID"; then
        warn "Stale Launch Services registration for $SMOKE_BUNDLE_ID"
        stale=1
    fi
    if [[ $stale -eq 1 ]]; then
        log "Running teardown to clean stale state before smoke"
        teardown || { err "Pre-smoke teardown failed; aborting"; return 1; }
    else
        ok "No stale state"
    fi
}

# ─── Build the bundle ───────────────────────────────────────────────────────
build_bundle() {
    log "Building $BUNDLE …"
    mkdir -p "$BUNDLE/Contents/MacOS"

    # Standalone Info.plist — adds CFBundleExecutable + CFBundlePackageType
    # (absent from the linker-embedded plist, required for LS validation).
    cat > "$BUNDLE/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>com.taproot.helper.smoke</string>
    <key>CFBundleName</key>
    <string>TaprootHelperSmoke</string>
    <key>CFBundleExecutable</key>
    <string>TaprootHelper</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key>
            <string>com.taproot.helper.smoke</string>
            <key>CFBundleURLSchemes</key>
            <array>
                <string>taproot</string>
            </array>
        </dict>
    </array>
</dict>
</plist>
PLIST

    if ! plutil -lint "$BUNDLE/Contents/Info.plist" >/dev/null; then
        err "Info.plist failed lint"
        return 1
    fi
    ok "Info.plist written + linted"

    cp "$BINARY_PATH" "$BUNDLE/Contents/MacOS/TaprootHelper"
    chmod +x "$BUNDLE/Contents/MacOS/TaprootHelper"
    ok "Binary copied + executable"

    # Ad-hoc resign the bundle as a whole. NO --deep (TN3127); inner binary
    # is already ad-hoc signed, no nested frameworks.
    if ! codesign --force --sign - "$BUNDLE" 2>/dev/null; then
        err "codesign failed"
        return 1
    fi

    # codesign --verify writes to stderr; merge to stdout for grep.
    local verify_out
    verify_out=$(codesign --verify --verbose=2 "$BUNDLE" 2>&1)
    if ! grep -q "valid on disk" <<<"$verify_out"; then
        err "codesign --verify did not report 'valid on disk'"
        echo "$verify_out" >&2
        return 1
    fi
    ok "Bundle ad-hoc signed + verified"
}

# ─── Register with Launch Services ──────────────────────────────────────────
register_bundle() {
    log "Registering $BUNDLE with Launch Services …"
    if ! "$LSREG" -f "$BUNDLE" 2>/dev/null; then
        err "lsregister -f failed"
        return 1
    fi
    ok "lsregister -f returned"

    log "Verifying registration before firing URL …"
    # Match: dump shows a block with our bundle id + a `bindings:` line for taproot:
    if ! "$LSREG" -dump 2>/dev/null | grep -B6 "bindings:.*taproot:" | grep -q "$SMOKE_BUNDLE_ID"; then
        err "lsregister -dump does not show taproot binding for $SMOKE_BUNDLE_ID"
        log "Dump excerpt for taproot bindings:"
        "$LSREG" -dump 2>/dev/null | grep -B2 "bindings:.*taproot:" | head -20 >&2 || true
        return 1
    fi
    ok "Registration confirmed in lsregister -dump"
}

# ─── Run the helper + fire the deep link ────────────────────────────────────
fire_deep_link() {
    # Swift's UUID.uuidString returns uppercase canonical form, and KeychainStore's
    # account format `workspace.<UUID.uuidString>.bearer` inherits that. Match
    # uuidgen's default (uppercase on macOS) so `security find-generic-password -a`
    # hits the same account string Swift wrote.
    TEST_UUID=$(uuidgen)
    TEST_BEARER="smoke-bearer-$(date +%s)-$$"
    log "Test UUID: $TEST_UUID"
    log "Test bearer: $TEST_BEARER"

    log "Launching helper (logs to $LOG_FILE)…"
    : > "$LOG_FILE"
    "$BUNDLE/Contents/MacOS/TaprootHelper" >"$LOG_FILE" 2>&1 &
    HELPER_PID=$!
    sleep 1

    if ! kill -0 "$HELPER_PID" 2>/dev/null; then
        err "Helper exited within 1s of launch"
        log "Tail of $LOG_FILE:"
        tail -20 "$LOG_FILE" >&2 || true
        return 1
    fi
    ok "Helper running (PID $HELPER_PID)"

    log "Firing deep link: taproot://auth?bearer=…&workspace=$TEST_UUID"
    if ! open "taproot://auth?bearer=${TEST_BEARER}&workspace=${TEST_UUID}" 2>/dev/null; then
        err "open returned non-zero (likely kLSApplicationNotFoundErr -10814)"
        return 1
    fi
    ok "open dispatched"

    # Poll keychain for up to 5s for the bearer to land
    log "Polling Keychain for up to 5s …"
    local found=""
    for _ in 1 2 3 4 5; do
        if found=$(security find-generic-password \
                -s "$KEYCHAIN_SERVICE" \
                -a "workspace.${TEST_UUID}.bearer" \
                -w 2>/dev/null); then
            break
        fi
        sleep 1
    done

    if [[ -z "$found" ]]; then
        err "Keychain entry never appeared"
        log "Tail of $LOG_FILE:"
        tail -20 "$LOG_FILE" >&2 || true
        return 1
    fi

    if [[ "$found" != "$TEST_BEARER" ]]; then
        err "Keychain bearer mismatch: expected '$TEST_BEARER', got '$found'"
        return 1
    fi
    ok "Keychain bearer matches expected value"

    if grep -q "Stored bearer for workspace ${TEST_UUID}" "$LOG_FILE"; then
        ok "Helper log confirms 'Stored bearer for workspace $TEST_UUID'"
    else
        warn "Helper log does NOT contain 'Stored bearer' line — but Keychain has it"
        log "Tail of $LOG_FILE:"
        tail -10 "$LOG_FILE" >&2 || true
    fi
}

# ─── Main ───────────────────────────────────────────────────────────────────
trap teardown EXIT

if [[ "${1:-}" == "--cleanup-only" ]]; then
    log "Cleanup-only mode"
    # teardown runs via trap. Exit 0 to indicate intentional cleanup.
    exit 0
fi

preflight        || exit 1
build_bundle     || exit 1
register_bundle  || exit 1
fire_deep_link   || exit 1

ok "SMOKE PASSED — taproot:// URL scheme verified end-to-end"
echo "SMOKE_PASS"
