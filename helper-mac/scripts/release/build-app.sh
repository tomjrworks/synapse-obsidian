#!/bin/bash
# build-app.sh — Build a Developer ID-signed TaprootHelper.app from the
# current Sources/TaprootHelper/Info.plist + swift release build. Mirrors
# the inline path used during the T11.8 manual smoke; closes the
# "via the existing build path" gap in T11.8-SMOKE.md step 2.
#
# Usage:
#   build-app.sh <output-dir> [--zip]
#
# Examples:
#   build-app.sh /tmp/staging-0.1.1
#   build-app.sh /tmp/staging-0.1.1 --zip
#
# Inputs:
#   <output-dir>          Destination for TaprootHelper.app (created if
#                         missing). Existing TaprootHelper.app inside is
#                         removed first; re-runs are idempotent.
#   --zip                 Also produce TaprootHelper-<short-version>.zip
#                         alongside the .app via `ditto -c -k --keepParent`
#                         (NOT `--sequenceNumber` — invalid macOS option).
#   TAPROOT_CODESIGN_IDENTITY  Override codesign identity (default: Tom's
#                              Developer ID Application certificate
#                              BC24E4A647583D1B567D8A0CD3DFBE74C3A2C522).
#
# Reads CFBundleShortVersionString + CFBundleVersion from
# Sources/TaprootHelper/Info.plist (single source of truth — does NOT
# bump; that's the operator's job via surgical Edit on a temp branch).
# Uses `swift build -c release --show-bin-path` to discover the per-arch
# SwiftPM output directory rather than hardcoding arm64-apple-macosx.

set -euo pipefail

usage() {
    echo "Usage: $(basename "$0") <output-dir> [--zip]" >&2
    exit 1
}

if [[ $# -lt 1 ]]; then
    usage
fi

OUTPUT_DIR="$1"
shift
WANT_ZIP=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --zip)
            WANT_ZIP=1
            shift
            ;;
        -h|--help)
            usage
            ;;
        *)
            echo "error: unknown flag: $1" >&2
            usage
            ;;
    esac
done

# Resolve helper-mac root: this script lives at helper-mac/scripts/release/.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER_MAC_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INFO_PLIST="$HELPER_MAC_ROOT/Sources/TaprootHelper/Info.plist"
IDENTITY="${TAPROOT_CODESIGN_IDENTITY:-BC24E4A647583D1B567D8A0CD3DFBE74C3A2C522}"

if [[ ! -f "$INFO_PLIST" ]]; then
    echo "error: Info.plist not found at $INFO_PLIST" >&2
    exit 1
fi

SHORT_VERSION="$(plutil -extract CFBundleShortVersionString raw -o - "$INFO_PLIST")"
BUNDLE_VERSION="$(plutil -extract CFBundleVersion raw -o - "$INFO_PLIST")"

if [[ -z "$SHORT_VERSION" || -z "$BUNDLE_VERSION" ]]; then
    echo "error: could not read version keys from $INFO_PLIST" >&2
    exit 1
fi

echo "==> Building TaprootHelper.app"
echo "    Source plist:   $INFO_PLIST"
echo "    Short version:  $SHORT_VERSION"
echo "    Bundle version: $BUNDLE_VERSION"
echo "    Identity:       $IDENTITY"
echo "    Output dir:     $OUTPUT_DIR"
echo

mkdir -p "$OUTPUT_DIR"
APP_PATH="$OUTPUT_DIR/TaprootHelper.app"
rm -rf "$APP_PATH"

echo "==> swift build -c release"
( cd "$HELPER_MAC_ROOT" && swift build -c release )

BIN_PATH="$( cd "$HELPER_MAC_ROOT" && swift build -c release --show-bin-path )"
EXEC_SRC="$BIN_PATH/TaprootHelper"
SPARKLE_SRC="$BIN_PATH/Sparkle.framework"

if [[ ! -f "$EXEC_SRC" ]]; then
    echo "error: built executable not found at $EXEC_SRC" >&2
    exit 1
fi
if [[ ! -d "$SPARKLE_SRC" ]]; then
    echo "error: Sparkle.framework not found at $SPARKLE_SRC" >&2
    exit 1
fi

echo "==> Building .app skeleton at $APP_PATH"
mkdir -p "$APP_PATH/Contents/MacOS"
mkdir -p "$APP_PATH/Contents/Resources"
mkdir -p "$APP_PATH/Contents/Frameworks"

cp "$EXEC_SRC" "$APP_PATH/Contents/MacOS/TaprootHelper"
cp "$INFO_PLIST" "$APP_PATH/Contents/Info.plist"
# `ditto` preserves the framework's Versions/Current symlinks + top-level
# aliases (Sparkle, Headers, Resources, Modules → Versions/Current/...).
# Plain `cp -R` may flatten on some macOS versions.
ditto "$SPARKLE_SRC" "$APP_PATH/Contents/Frameworks/Sparkle.framework"

echo "==> install_name_tool: add @executable_path/../Frameworks rpath"
# SwiftPM doesn't add this rpath to executables by default. Without it,
# dyld fails to resolve Sparkle.framework at launch and the helper exits
# immediately. Confirmed against the smoke build's otool output.
install_name_tool -add_rpath "@executable_path/../Frameworks" "$APP_PATH/Contents/MacOS/TaprootHelper"

# Inside-out codesign: the framework's signature seals over its nested
# XPCs / Updater.app / Autoupdate, so those must be signed first or the
# framework's --verify fails. Order matches the smoke; deviating from it
# produces "code object is not signed at all" errors during verification.
SPARKLE_FW="$APP_PATH/Contents/Frameworks/Sparkle.framework"
SPARKLE_VER_DIR="$SPARKLE_FW/Versions/B"

sign() {
    local target="$1"
    echo "    codesign: $target"
    codesign --force --options runtime --sign "$IDENTITY" "$target"
}

echo "==> Inside-out codesign"
sign "$SPARKLE_VER_DIR/XPCServices/Downloader.xpc"
sign "$SPARKLE_VER_DIR/XPCServices/Installer.xpc"
sign "$SPARKLE_VER_DIR/Updater.app"
sign "$SPARKLE_VER_DIR/Autoupdate"
sign "$SPARKLE_FW"
sign "$APP_PATH"

echo "==> codesign --verify --deep --strict"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

if [[ $WANT_ZIP -eq 1 ]]; then
    ZIP_NAME="TaprootHelper-$SHORT_VERSION.zip"
    ZIP_PATH="$OUTPUT_DIR/$ZIP_NAME"
    echo "==> ditto -c -k --keepParent → $ZIP_PATH"
    rm -f "$ZIP_PATH"
    ( cd "$OUTPUT_DIR" && ditto -c -k --keepParent "TaprootHelper.app" "$ZIP_NAME" )
fi

echo
echo "==> DONE"
echo "    .app:     $APP_PATH"
echo "    version:  $SHORT_VERSION ($BUNDLE_VERSION)"
echo "    identity: $IDENTITY"
if [[ $WANT_ZIP -eq 1 ]]; then
    echo "    zip:      $OUTPUT_DIR/TaprootHelper-$SHORT_VERSION.zip"
fi
