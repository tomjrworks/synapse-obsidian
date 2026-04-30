import XCTest
@testable import TaprootHelper

@MainActor
final class UpdateCoordinatorTests: XCTestCase {
    private var fake: FakeUpdaterService!
    private var coord: UpdateCoordinator!
    private var defaults: UserDefaults!
    private var suite: String!

    override func setUpWithError() throws {
        suite = "test-update-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
        // Cleanest setup: ensure no leftover state from a parallel xctest.
        defaults.removePersistentDomain(forName: suite)
        fake = FakeUpdaterService()
        let store = SettingsStore(defaults: defaults)
        coord = UpdateCoordinator(updater: fake, settingsStore: store)
    }

    override func tearDownWithError() throws {
        defaults.removePersistentDomain(forName: suite)
    }

    func testStartCallsUpdaterStart() {
        XCTAssertEqual(fake.startCallCount, 0)

        coord.start()

        XCTAssertEqual(fake.startCallCount, 1)
        XCTAssertTrue(fake.isStarted)
    }

    func testCheckForUpdatesProxiesToUpdater() {
        coord.checkForUpdates()
        coord.checkForUpdates()

        XCTAssertEqual(fake.checkForUpdatesCallCount, 2)
    }

    func testAutomaticallyInstallsUpdatesPersistsToSettingsStore() {
        XCTAssertFalse(coord.automaticallyInstallsUpdates,
                       "L1 default: prompt-first install behavior")

        coord.automaticallyInstallsUpdates = true

        XCTAssertTrue(coord.automaticallyInstallsUpdates)
        XCTAssertTrue(fake.automaticallyInstallsUpdates,
                      "Setter must propagate to the underlying updater immediately")

        // Round-trip via fresh SettingsStore → asserts the value lives
        // in UserDefaults, not just in the Coordinator's struct copy.
        let fresh = SettingsStore(defaults: UserDefaults(suiteName: suite)!)
        XCTAssertTrue(fresh.automaticallyInstallsUpdates)
    }

    func testStartPushesPersistedAutoInstallToUpdater() {
        // Pre-set the SettingsStore's persisted value, then construct a
        // fresh Coordinator. start() must propagate the persisted value
        // into the updater so a relaunch with autoInstall=true respects
        // the user's prior choice.
        defaults.set(true, forKey: "taproot.settings.automaticallyInstallsUpdates")
        let store = SettingsStore(defaults: defaults)
        let freshCoord = UpdateCoordinator(updater: fake, settingsStore: store)

        XCTAssertFalse(fake.automaticallyInstallsUpdates, "Pre: updater untouched")

        freshCoord.start()

        XCTAssertTrue(fake.automaticallyInstallsUpdates,
                      "start() must push persisted preference to the updater")
    }

    func testRelaunchVetoFiresWhenIsBusy() {
        coord.isBusy = { true }
        coord.start()

        XCTAssertTrue(fake.shouldRelaunchVeto(),
                      "Veto must postpone Sparkle's relaunch while busy")
    }

    func testRelaunchVetoAllowsWhenIdle() {
        coord.isBusy = { false }
        coord.start()

        XCTAssertFalse(fake.shouldRelaunchVeto(),
                       "Veto must allow Sparkle's relaunch when not busy")
    }

    func testIsBusyChangesAfterStartAreObservedByVeto() {
        // The veto closure captures self weakly and re-evaluates isBusy on
        // every call — so flipping isBusy AFTER start() is honored. Lock
        // this in: a snapshot-on-start would silently break commit 6's
        // pushInFlight integration.
        var busy = false
        coord.isBusy = { busy }
        coord.start()

        XCTAssertFalse(fake.shouldRelaunchVeto())
        busy = true
        XCTAssertTrue(fake.shouldRelaunchVeto())
        busy = false
        XCTAssertFalse(fake.shouldRelaunchVeto())
    }
}
