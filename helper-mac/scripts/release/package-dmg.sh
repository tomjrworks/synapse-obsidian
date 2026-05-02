#!/bin/bash
set -euo pipefail
# Usage: package-dmg.sh <app-path> <output-dir>
# Requires: create-dmg (brew install create-dmg)
# Produces: <output-dir>/TaprootHelper-<version>.dmg, signed with Developer ID Application

if [[ $# -lt 2 ]]; then
    echo "Usage: $(basename "$0") <app-path> <output-dir>" >&2
    exit 1
fi

APP_PATH="$1"
OUTPUT_DIR="$2"

if [[ ! -d "$APP_PATH" ]]; then
    echo "Error: app not found at $APP_PATH" >&2
    exit 1
fi

if [[ ! -d "$OUTPUT_DIR" ]]; then
    echo "Error: output dir not found at $OUTPUT_DIR" >&2
    exit 1
fi

SHORT_VERSION="$(plutil -extract CFBundleShortVersionString raw -o - "$APP_PATH/Contents/Info.plist")"
DMG_NAME="TaprootHelper-${SHORT_VERSION}.dmg"
DMG_PATH="$OUTPUT_DIR/$DMG_NAME"
IDENTITY="${TAPROOT_CODESIGN_IDENTITY:-BC24E4A647583D1B567D8A0CD3DFBE74C3A2C522}"

echo "==> Packaging TaprootHelper $SHORT_VERSION → $DMG_PATH"

# Stage in a clean temp dir so create-dmg only sees the .app
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

ditto "$APP_PATH" "$STAGE_DIR/TaprootHelper.app"

rm -f "$DMG_PATH"

create-dmg \
    --volname "Taproot Helper $SHORT_VERSION" \
    --window-size 540 380 \
    --icon-size 96 \
    --icon "TaprootHelper.app" 130 200 \
    --app-drop-link 410 200 \
    --no-internet-enable \
    --skip-jenkins \
    "$DMG_PATH" \
    "$STAGE_DIR"

echo "==> Signing DMG"
codesign --force --timestamp --sign "$IDENTITY" "$DMG_PATH"
codesign --verify --verbose=2 "$DMG_PATH"

echo "==> DONE: $DMG_PATH"
echo ""
echo "Next step: bash scripts/release/notarize.sh --dmg $DMG_PATH"
