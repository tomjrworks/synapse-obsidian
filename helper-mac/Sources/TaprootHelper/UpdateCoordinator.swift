import Foundation

/// Owns the auto-update lifecycle: persists the user's
/// auto-install preference, wires Sparkle's relaunch veto, and
/// proxies Settings → Check-for-updates clicks.
///
/// `isBusy` is a synchronous predicate set by AppDelegate. The wiring lands
/// in two passes: commit 4 covers the first-run-window gate; commit 6 adds
/// the `SyncEngine.pushInFlight` gate (V3 atomic counter) on top.
@MainActor
final class UpdateCoordinator {
    private let updater: UpdaterService
    private var settingsStore: SettingsStore

    /// Returns `true` while it would be unsafe for Sparkle to relaunch the
    /// helper (e.g. first-run window open, in-flight push). Sparkle's
    /// postpone hook polls this every 2s; default returns `false` so a
    /// freshly constructed Coordinator does not trap relaunch.
    var isBusy: @MainActor () -> Bool = { false }

    init(updater: UpdaterService, settingsStore: SettingsStore) {
        self.updater = updater
        self.settingsStore = settingsStore
    }

    /// Pushes the persisted auto-install preference to the updater, wires
    /// the relaunch veto, then asks Sparkle to start scheduled checks.
    /// Idempotent against the underlying updater (FakeUpdaterService bumps
    /// a counter; SparkleUpdaterService guards with `isStarted`).
    func start() {
        updater.automaticallyInstallsUpdates = settingsStore.automaticallyInstallsUpdates
        updater.shouldRelaunchVeto = { [weak self] in self?.isBusy() ?? false }
        updater.start()
    }

    /// Surfaces Sparkle's standard "Check for updates" window. Wired
    /// to the Settings → Check-for-updates button in commit 5.
    func checkForUpdates() {
        updater.checkForUpdates()
    }

    /// End-to-end auto-install plumbing — SettingsStore round-trip + Sparkle
    /// proxy. UI is intentionally deferred: Stage 1 ships with the manual
    /// "Check for updates" button only, and the manual smoke (T11.8.8) drives
    /// auto-install via `defaults write SUAutomaticallyUpdate -bool YES` so
    /// we exercise the silent-install relaunch-gate path before adding a
    /// user-facing checkbox. A future Settings revision can wire this
    /// accessor without touching the updater layer.
    var automaticallyInstallsUpdates: Bool {
        get { settingsStore.automaticallyInstallsUpdates }
        set {
            settingsStore.automaticallyInstallsUpdates = newValue
            updater.automaticallyInstallsUpdates = newValue
        }
    }
}
