import Foundation

/// Owns the auto-update lifecycle: persists the user's
/// auto-download preference, wires Sparkle's relaunch veto, and
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

    /// Diagnostic state captured at the 60s fall-through NSLog. AppDelegate
    /// wires this alongside `isBusy` with a snapshot of pushInFlight +
    /// firstRunWindowOpen. Empty default so a freshly-constructed Coordinator
    /// (or any test that doesn't inject) emits the unaugmented log line.
    var diagnosticSnapshot: @MainActor () -> String = { "" }

    init(updater: UpdaterService, settingsStore: SettingsStore) {
        self.updater = updater
        self.settingsStore = settingsStore
    }

    /// Pushes the persisted auto-download preference to the updater, wires
    /// the relaunch veto, then asks Sparkle to start scheduled checks.
    /// Idempotent against the underlying updater (FakeUpdaterService bumps
    /// a counter; SparkleUpdaterService guards with `isStarted`).
    func start() {
        updater.automaticallyDownloadsUpdates = settingsStore.automaticallyDownloadsUpdates
        updater.shouldRelaunchVeto = { [weak self] in self?.isBusy() ?? false }
        updater.diagnosticSnapshot = { [weak self] in self?.diagnosticSnapshot() ?? "" }
        updater.start()
    }

    /// Surfaces Sparkle's standard "Check for updates" window. Wired
    /// to the Settings → Check-for-updates button in commit 5.
    func checkForUpdates() {
        updater.checkForUpdates()
    }

    /// End-to-end auto-download plumbing — SettingsStore round-trip + Sparkle
    /// proxy. UI is intentionally deferred: Stage 1 ships with the manual
    /// "Check for updates" button only; auto-download is exercised by
    /// `defaults write taproot.settings.automaticallyDownloadsUpdates -bool YES`
    /// per `T11.8-SMOKE.md` step 8a. A future Settings revision can wire this
    /// accessor without touching the updater layer.
    var automaticallyDownloadsUpdates: Bool {
        get { settingsStore.automaticallyDownloadsUpdates }
        set {
            settingsStore.automaticallyDownloadsUpdates = newValue
            updater.automaticallyDownloadsUpdates = newValue
        }
    }
}
