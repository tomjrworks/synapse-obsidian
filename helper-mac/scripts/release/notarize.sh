#!/bin/bash
set -euo pipefail
# Usage:
#   notarize.sh --app <app-path>   # zip → submit → staple .app
#   notarize.sh --dmg <dmg-path>   # submit → staple .dmg
#
# Reads keychain profile from $TAPROOT_NOTARY_PROFILE (default: taproot-notary).
# Requires: xcrun notarytool (Xcode 13+), xcrun stapler
# On rejection: notarytool exits non-zero and prints submission ID.
#   Inspect with: xcrun notarytool log <id> --keychain-profile taproot-notary

PROFILE="${TAPROOT_NOTARY_PROFILE:-taproot-notary}"

if [[ $# -lt 2 ]]; then
    echo "Usage: $(basename "$0") --app <app-path> | --dmg <dmg-path>" >&2
    exit 1
fi

case "$1" in
    --app)
        APP="$2"
        if [[ ! -d "$APP" ]]; then
            echo "Error: app not found at $APP" >&2
            exit 1
        fi
        ZIP="$(dirname "$APP")/_notarize-$(basename "$APP" .app).zip"
        rm -f "$ZIP"
        echo "==> Zipping $APP → $ZIP"
        ditto -c -k --keepParent "$APP" "$ZIP"
        echo "==> Submitting to notarytool (profile: $PROFILE) — this takes 1–5 min…"
        xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait
        rm -f "$ZIP"
        echo "==> Stapling $APP"
        xcrun stapler staple "$APP"
        xcrun stapler validate "$APP"
        echo "==> DONE: $APP is notarized and stapled"
        echo ""
        echo "Next steps:"
        echo "  1. Re-zip the stapled .app for Sparkle delivery:"
        echo "     ditto -c -k --keepParent \"$APP\" \"$(dirname "$APP")/TaprootHelper-<version>.zip\""
        echo "  2. Package the DMG:"
        echo "     bash scripts/release/package-dmg.sh \"$APP\" \"$(dirname "$APP")\""
        ;;
    --dmg)
        DMG="$2"
        if [[ ! -f "$DMG" ]]; then
            echo "Error: DMG not found at $DMG" >&2
            exit 1
        fi
        echo "==> Submitting $DMG to notarytool (profile: $PROFILE) — this takes 1–5 min…"
        xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
        echo "==> Stapling $DMG"
        xcrun stapler staple "$DMG"
        xcrun stapler validate "$DMG"
        echo "==> DONE: $DMG is notarized and stapled"
        echo ""
        echo "Next step: upload both artifacts to R2:"
        DMG_NAME="$(basename "$DMG")"
        VERSION="${DMG_NAME#TaprootHelper-}"
        VERSION="${VERSION%.dmg}"
        echo "  wrangler r2 object put taproot-downloads/releases/v${VERSION}/${DMG_NAME} --file=\"$DMG\""
        echo "  wrangler r2 object put taproot-downloads/releases/v${VERSION}/TaprootHelper-${VERSION}.zip --file=\"<path-to-reziped-app.zip>\""
        ;;
    *)
        echo "Usage: $(basename "$0") --app <app-path> | --dmg <dmg-path>" >&2
        exit 1
        ;;
esac
