import XCTest
@testable import TaprootHelper

final class SettingsStoreTests: XCTestCase {
    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUpWithError() throws {
        suiteName = "test-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDownWithError() throws {
        defaults.removePersistentDomain(forName: suiteName)
    }

    func testNotificationsEnabledDefaultsFalse() {
        let store = SettingsStore(defaults: defaults)
        XCTAssertFalse(store.notificationsEnabled)
    }

    func testNotificationsEnabledRoundTrips() {
        var store = SettingsStore(defaults: defaults)
        store.notificationsEnabled = true
        XCTAssertTrue(SettingsStore(defaults: defaults).notificationsEnabled)
    }

    func testIsPausedOnLaunchDefaultsFalseForUnknownWorkspace() {
        let store = SettingsStore(defaults: defaults)
        XCTAssertFalse(store.isPausedOnLaunch(for: UUID()))
    }

    func testSetPausedOnLaunchPersists() {
        let store = SettingsStore(defaults: defaults)
        let id = UUID()

        store.setPausedOnLaunch(true, for: id)

        XCTAssertTrue(SettingsStore(defaults: defaults).isPausedOnLaunch(for: id))
    }

    func testClearPausedOnLaunchRemovesKey() {
        let store = SettingsStore(defaults: defaults)
        let id = UUID()
        store.setPausedOnLaunch(true, for: id)
        XCTAssertTrue(store.isPausedOnLaunch(for: id))

        store.clearPausedOnLaunch(for: id)

        XCTAssertFalse(store.isPausedOnLaunch(for: id))
        XCTAssertNil(defaults.object(forKey: "taproot.pausedOnLaunch.\(id.uuidString)"))
    }
}
