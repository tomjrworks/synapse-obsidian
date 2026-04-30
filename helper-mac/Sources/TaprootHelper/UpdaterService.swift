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
    /// Lazy so `self` is fully constructed by the time the controller is
    /// built — `updaterDelegate: self` requires that. Sparkle's delegate
    /// reference is `weak`, so no retain cycle.
    /// userDriverDelegate stays nil — Sparkle's standard UI is fine for
    /// Stage 1 (L4 lock). startingUpdater=false hands the launch decision
    /// to AppDelegate.
    private lazy var controller: SPUStandardUpdaterController = {
        SPUStandardUpdaterController(
            startingUpdater: false,
            updaterDelegate: self,
            userDriverDelegate: nil
        )
    }()

    private(set) var isStarted: Bool = false
    var shouldRelaunchVeto: @MainActor () -> Bool = { false }

    var automaticallyInstallsUpdates: Bool {
        get { controller.updater.automaticallyDownloadsUpdates }
        set { controller.updater.automaticallyDownloadsUpdates = newValue }
    }

    /// Stored install handler from Sparkle's postpone hook. Re-fired by the
    /// poll once `shouldRelaunchVeto()` clears, or by the 60s fall-through.
    private var pendingInstallHandler: (() -> Void)?
    /// Wall-clock start of the current postpone window — used to enforce
    /// the V4 60s fall-through cap.
    private var postponeStartTime: Date?
    private var postponePoller: Timer?

    /// Hard ceiling on relaunch postponement so a stuck push / orphaned
    /// firstRun window can't pin the update forever.
    private static let postponeFallThroughSeconds: TimeInterval = 60.0
    private static let postponePollInterval: TimeInterval = 2.0

    func start() {
        guard !isStarted else { return }
        controller.startUpdater()
        isStarted = true
    }

    func checkForUpdates() {
        controller.checkForUpdates(nil)
    }

    // MARK: SPUUpdaterDelegate

    /// V4: stores Sparkle's install handler when busy and re-fires it on
    /// a 2s poll once the gate clears. Returning `true` tells Sparkle to
    /// wait. 60s fall-through cap prevents indefinite pinning.
    nonisolated func updater(
        _ updater: SPUUpdater,
        shouldPostponeRelaunchForUpdate item: SUAppcastItem,
        untilInvokingBlock installHandler: @escaping () -> Void
    ) -> Bool {
        // Hop to MainActor — Sparkle calls this on the main thread but
        // the protocol method itself isn't isolated.
        MainActor.assumeIsolated {
            guard self.shouldRelaunchVeto() else {
                return false
            }
            self.pendingInstallHandler = installHandler
            self.postponeStartTime = Date()
            self.startPostponePoll()
            return true
        }
    }

    private func startPostponePoll() {
        postponePoller?.invalidate()
        postponePoller = Timer.scheduledTimer(
            withTimeInterval: Self.postponePollInterval,
            repeats: true
        ) { [weak self] timer in
            MainActor.assumeIsolated {
                guard let self else { timer.invalidate(); return }
                if let start = self.postponeStartTime,
                   Date().timeIntervalSince(start) >= Self.postponeFallThroughSeconds {
                    NSLog("[Taproot] update relaunch: 60s fall-through; allowing relaunch despite veto")
                    self.firePending()
                    timer.invalidate()
                    return
                }
                if !self.shouldRelaunchVeto() {
                    self.firePending()
                    timer.invalidate()
                }
            }
        }
    }

    private func firePending() {
        let handler = pendingInstallHandler
        pendingInstallHandler = nil
        postponeStartTime = nil
        postponePoller = nil
        handler?()
    }
}
