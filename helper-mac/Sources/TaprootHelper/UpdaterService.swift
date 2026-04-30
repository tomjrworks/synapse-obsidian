import AppKit
import Sparkle

/// Protocol-wraps the Sparkle updater so AppDelegate / UpdateCoordinator can
/// be tested against a `FakeUpdaterService` without spinning up a real
/// `SPUStandardUpdaterController` (which requires NSApplication run-loop
/// state and a full Info.plist with valid SUPublicEDKey).
///
/// Only the surface our code drives is exposed here. Sparkle's standard UI
/// (Skip / Remind Later / Install dialog, "You're up to date" panel,
/// progress indicator) is opaque from this seam — that's intentional, per
/// L4 (use Sparkle's standard window, no custom SPUUserDriver).
@MainActor
protocol UpdaterService: AnyObject {
    var isStarted: Bool { get }
    /// Calls Sparkle's `startUpdater()`. AppDelegate sequences this AFTER
    /// loadWorkspacesFromKeychain so a launch-via-deep-link can settle
    /// before the updater queues its first scheduled check.
    func start()
    /// Surfaces Sparkle's standard "Check for updates" window — the same
    /// path the Settings → Check-for-updates button triggers.
    func checkForUpdates()
    /// User preference: install updates without a confirmation dialog.
    /// L1 default is `false` (prompt-first); persisted via SettingsStore.
    var automaticallyInstallsUpdates: Bool { get set }
    /// Synchronous predicate that gates Sparkle's relaunch. `true` →
    /// postpone (in-flight push or first-run window open); `false` →
    /// allow. Polled every 2s by the relaunch hook in commit 6.
    var shouldRelaunchVeto: @MainActor () -> Bool { get set }
}

/// Production implementation backed by Sparkle's `SPUStandardUpdaterController`.
/// Holds the controller with `startingUpdater: false` so AppDelegate calls
/// `start()` explicitly — controls sequencing relative to first-run.
@MainActor
final class SparkleUpdaterService: NSObject, UpdaterService, SPUUpdaterDelegate {
    private let controller: SPUStandardUpdaterController

    private(set) var isStarted: Bool = false
    var shouldRelaunchVeto: @MainActor () -> Bool = { false }

    var automaticallyInstallsUpdates: Bool {
        get { controller.updater.automaticallyDownloadsUpdates }
        set { controller.updater.automaticallyDownloadsUpdates = newValue }
    }

    override init() {
        // userDriverDelegate stays nil — Sparkle's standard UI is fine for
        // Stage 1 (L4 lock). startingUpdater=false hands the launch decision
        // to AppDelegate.
        // Note: super.init() needs to land before `self` is reachable, so
        // we construct the controller with a placeholder delegate, then
        // re-set after super.init().
        self.controller = SPUStandardUpdaterController(
            startingUpdater: false,
            updaterDelegate: nil,
            userDriverDelegate: nil
        )
        super.init()
    }

    func start() {
        guard !isStarted else { return }
        controller.startUpdater()
        isStarted = true
    }

    func checkForUpdates() {
        controller.checkForUpdates(nil)
    }
}
