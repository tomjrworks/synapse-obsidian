import XCTest
import AppKit
@testable import TaprootHelper

@MainActor
final class UpdaterServiceTests: XCTestCase {
    func testFakeUpdaterServiceRecordsStart() {
        let fake = FakeUpdaterService()
        XCTAssertFalse(fake.isStarted)
        XCTAssertEqual(fake.startCallCount, 0)

        fake.start()

        XCTAssertTrue(fake.isStarted)
        XCTAssertEqual(fake.startCallCount, 1)

        // start() is idempotent at the recorder level: subsequent calls
        // bump the counter so tests can detect double-start regressions.
        fake.start()
        XCTAssertEqual(fake.startCallCount, 2)
    }

    func testFakeUpdaterServiceRecordsCheckForUpdates() {
        let fake = FakeUpdaterService()
        XCTAssertEqual(fake.checkForUpdatesCallCount, 0)

        fake.checkForUpdates()
        fake.checkForUpdates()

        XCTAssertEqual(fake.checkForUpdatesCallCount, 2)
    }

    func testFakeUpdaterServiceVetoDefaultIsFalse() {
        let fake = FakeUpdaterService()
        XCTAssertFalse(fake.shouldRelaunchVeto(),
                       "Default veto must be false so Sparkle can relaunch when nothing's busy")
    }

    func testFakeUpdaterServiceVetoIsHonored() {
        let fake = FakeUpdaterService()
        var busy = true
        fake.shouldRelaunchVeto = { busy }

        XCTAssertTrue(fake.shouldRelaunchVeto(),
                      "Veto must return true while busy → Sparkle postpones relaunch")

        busy = false
        XCTAssertFalse(fake.shouldRelaunchVeto(),
                       "Veto must return false when no longer busy → Sparkle relaunches")
    }

    func testFakeUpdaterServiceAutomaticallyDownloadsRoundTrip() {
        let fake = FakeUpdaterService()
        XCTAssertFalse(fake.automaticallyDownloadsUpdates,
                       "L1 default: prompt-first install behavior")

        fake.automaticallyDownloadsUpdates = true

        XCTAssertTrue(fake.automaticallyDownloadsUpdates)
    }

    /// Live SparkleUpdaterService construction smoke. Verifies our wrapper
    /// composes against the real `SPUStandardUpdaterController` without
    /// `startUpdater()` firing automatically (the L4 sequencing lock).
    /// Gated behind `TAPROOT_SKIP_SPARKLE_LIVE_TEST` because headless xctest
    /// doesn't always tolerate Sparkle's `Bundle.main` plist lookup —
    /// the executable bundle in test mode is xctest, not TaprootHelper.
    func testSparkleUpdaterServiceConstructsLive() {
        if ProcessInfo.processInfo.environment["TAPROOT_SKIP_SPARKLE_LIVE_TEST"] != nil {
            return
        }
        // NSApp must exist before SPUStandardUpdaterController init.
        _ = NSApplication.shared

        let live = SparkleUpdaterService()

        XCTAssertFalse(live.isStarted,
                       "startingUpdater:false in init means our explicit start() controls sequencing")
    }
}
