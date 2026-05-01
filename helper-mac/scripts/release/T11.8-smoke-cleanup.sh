#!/bin/bash
# T11.8 smoke cleanup — reverts UserDefaults overrides set during the
# manual 10-step smoke (defaults write SUFeedURL <staging>, etc.). After
# running this, the helper uses Info.plist defaults on next launch.
set -u
defaults delete com.taproot.helper SUFeedURL            2>/dev/null || true
defaults delete com.taproot.helper SUAutomaticallyUpdate 2>/dev/null || true
defaults delete com.taproot.helper SUSkippedVersion      2>/dev/null || true
# SettingsStore key is the one that actually drives Sparkle behavior —
# SUAutomaticallyUpdate above gets overwritten by UpdateCoordinator.start()
# at every launch from this key. The smoke proved removing only the SU*
# keys leaves stale state if 8a was exercised.
defaults delete com.taproot.helper "taproot.settings.automaticallyInstallsUpdates" 2>/dev/null || true
echo "Smoke overrides cleaned. Helper will use Info.plist defaults next launch."
