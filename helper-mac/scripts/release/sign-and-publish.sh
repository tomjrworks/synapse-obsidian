#!/bin/bash
# T11.10 release tooling — signs a packaged TaprootHelper DMG with the EdDSA
# private key Sparkle holds in Keychain (`https://sparkle-project.org` /
# `ed25519`), substitutes placeholders into appcast-template.xml, and PRINTS
# the wrangler upload commands. It does NOT execute uploads — Tom runs those
# by hand so a misfired script can't accidentally publish to prod.
#
# Usage:
#   sign-and-publish.sh <short-version> <bundle-version> <dmg-path> [--prod] [--release-notes <html>]
#
# Examples:
#   sign-and-publish.sh 0.1.2 3 ~/Downloads/taproot-releases/0.1.2/TaprootHelper-0.1.2.dmg
#   sign-and-publish.sh 0.1.2 3 ~/Downloads/taproot-releases/0.1.2/TaprootHelper-0.1.2.dmg --prod
#   sign-and-publish.sh 0.1.2 3 ./out/TaprootHelper-0.1.2.dmg --release-notes '<p>Bugfix release.</p>'
#
# Output: helper-mac/scripts/release/out/appcast.xml plus the wrangler r2 +
# pages commands printed to stdout. Single-version mode — multi-version
# appcast merging is not currently needed (Sparkle reads the single feed
# and the <item> block changes per release).

set -euo pipefail

usage() {
    echo "Usage: $(basename "$0") <short-version> <bundle-version> <dmg-path> [--prod] [--release-notes <html>]" >&2
    exit 1
}

if [[ $# -lt 3 ]]; then
    usage
fi

SHORT_VERSION="$1"
BUNDLE_VERSION="$2"
DMG_PATH="$3"
shift 3

IS_PROD=0
RELEASE_NOTES_HTML="<p>Auto-update support (T11.8).</p>"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --prod)
            IS_PROD=1
            shift
            ;;
        --release-notes)
            if [[ $# -lt 2 ]]; then
                echo "error: --release-notes needs a value" >&2
                exit 1
            fi
            RELEASE_NOTES_HTML="$2"
            shift 2
            ;;
        *)
            echo "error: unknown flag: $1" >&2
            usage
            ;;
    esac
done

if [[ ! -f "$DMG_PATH" ]]; then
    echo "error: DMG not found at $DMG_PATH" >&2
    exit 1
fi

# Resolve helper-mac root: this script lives at helper-mac/scripts/release/.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER_MAC_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SIGN_UPDATE="$HELPER_MAC_ROOT/.build/artifacts/sparkle/Sparkle/bin/sign_update"
TEMPLATE="$SCRIPT_DIR/appcast-template.xml"
OUT_DIR="$SCRIPT_DIR/out"
OUT_FILE="$OUT_DIR/appcast.xml"

if [[ ! -x "$SIGN_UPDATE" ]]; then
    echo "error: sign_update not found or not executable at $SIGN_UPDATE" >&2
    echo "       run 'swift build -c release' first to resolve the Sparkle xcframework" >&2
    exit 1
fi

if [[ ! -f "$TEMPLATE" ]]; then
    echo "error: appcast-template.xml missing at $TEMPLATE" >&2
    exit 1
fi

mkdir -p "$OUT_DIR"

# `sign_update` prints e.g.: sparkle:edSignature="..." length="..."
# Capture full stdout and pull the signature substring out for substitution.
SIGN_OUTPUT="$("$SIGN_UPDATE" "$DMG_PATH")"
ED_SIGNATURE="$(echo "$SIGN_OUTPUT" | sed -n 's/.*sparkle:edSignature="\([^"]*\)".*/\1/p')"
if [[ -z "$ED_SIGNATURE" ]]; then
    echo "error: could not parse edSignature from sign_update output:" >&2
    echo "$SIGN_OUTPUT" >&2
    exit 1
fi

LENGTH="$(stat -f %z "$DMG_PATH")"
PUB_DATE="$(date -u "+%a, %d %b %Y %H:%M:%S +0000")"

# Substitute placeholders. Use a delimiter unlikely to appear in HTML
# release notes (`|`) for the notes, since the default delimiter `/` will
# collide with HTML tag closers.
sed \
    -e "s|__SHORT_VERSION__|$SHORT_VERSION|g" \
    -e "s|__BUNDLE_VERSION__|$BUNDLE_VERSION|g" \
    -e "s|__PUB_DATE__|$PUB_DATE|g" \
    -e "s|__LENGTH__|$LENGTH|g" \
    -e "s|__ED_SIGNATURE__|$ED_SIGNATURE|g" \
    -e "s|__RELEASE_NOTES_HTML__|$RELEASE_NOTES_HTML|g" \
    "$TEMPLATE" > "$OUT_FILE"

echo "Wrote: $OUT_FILE"
echo
echo "Next — run these by hand (this script does NOT execute them):"
echo
echo "  # 1. Upload the signed DMG to R2 (--remote required: without it,"
echo "  #    wrangler writes to the local miniflare simulator only.)"
echo "  wrangler r2 object put taproot-releases/releases/v$SHORT_VERSION/TaprootHelper-$SHORT_VERSION.dmg --file=$DMG_PATH --content-type=application/x-apple-diskimage --remote"
echo
if [[ $IS_PROD -eq 1 ]]; then
    echo "  # 2. Deploy the appcast to PROD (updates.taproothq.com)"
    echo "  wrangler pages deploy $OUT_DIR --project-name=taproot-updates --branch=main"
    echo
    echo "  # Live at: https://updates.taproothq.com/appcast.xml"
else
    echo "  # 2. Deploy the appcast to a STAGING preview"
    echo "  wrangler pages deploy $OUT_DIR --project-name=taproot-updates"
    echo
    echo "  # Tom: copy the preview URL printed by wrangler above; that's"
    echo "  # your staging URL for the smoke. The static -staging slug doesn't"
    echo "  # exist — wrangler emits a per-deploy preview like"
    echo "  # https://<commit>.taproot-updates.pages.dev/appcast.xml"
fi
