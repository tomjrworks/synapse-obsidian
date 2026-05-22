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

    func testAutomaticallyDownloadsUpdatesDefaultsFalse() {
        let store = SettingsStore(defaults: defaults)
        XCTAssertFalse(store.automaticallyDownloadsUpdates,
                       "L1 default: prompt-first install behavior")
    }

    func testAutomaticallyDownloadsUpdatesRoundTrips() {
        var store = SettingsStore(defaults: defaults)
        store.automaticallyDownloadsUpdates = true
        XCTAssertTrue(SettingsStore(defaults: defaults).automaticallyDownloadsUpdates)
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

    func testWorkspaceNameRoundTrips() {
        let store = SettingsStore(defaults: defaults)
        let id = UUID()

        store.setWorkspaceName("Toms Vault", for: id)

        XCTAssertEqual(SettingsStore(defaults: defaults).workspaceName(for: id), "Toms Vault")
    }

    func testWorkspaceNameDefaultsNilForUnknown() {
        let store = SettingsStore(defaults: defaults)
        XCTAssertNil(store.workspaceName(for: UUID()))
    }

    func testClearWorkspaceNameRemovesKey() {
        let store = SettingsStore(defaults: defaults)
        let id = UUID()
        store.setWorkspaceName("X", for: id)
        XCTAssertEqual(store.workspaceName(for: id), "X")

        store.clearWorkspaceName(for: id)

        XCTAssertNil(store.workspaceName(for: id))
        XCTAssertNil(defaults.object(forKey: "taproot.workspaceName.\(id.uuidString)"))
    }

    // MARK: - vaultBookmark (0.2.2 sandbox)

    func testVaultBookmarkReturnsNilWhenUnset() {
        let store = SettingsStore(defaults: defaults)
        XCTAssertNil(store.vaultBookmark(for: UUID()))
    }

    func testSetVaultBookmarkPersistsAndRetrievesData() {
        let store = SettingsStore(defaults: defaults)
        let id = UUID()
        let blob = Data([0x01, 0x02, 0x03, 0x04])

        store.setVaultBookmark(blob, for: id)

        XCTAssertEqual(SettingsStore(defaults: defaults).vaultBookmark(for: id), blob)
    }

    /// Defense-in-depth: writing a new bookmark always clears any stale legacy
    /// path-string key so a future helper version that drops the legacy reader
    /// can't see stale data.
    func testSetVaultBookmarkClearsLegacyPathStringKey() {
        let store = SettingsStore(defaults: defaults)
        let id = UUID()
        defaults.set("/tmp/old-prefs", forKey: "taproot.vaultFolder.\(id.uuidString)")

        store.setVaultBookmark(Data([0xAA]), for: id)

        XCTAssertNil(defaults.object(forKey: "taproot.vaultFolder.\(id.uuidString)"))
        XCTAssertNotNil(store.vaultBookmark(for: id))
    }

    func testConsumeLegacyVaultFolderPathReturnsValueAndClearsKey() {
        let store = SettingsStore(defaults: defaults)
        let id = UUID()
        defaults.set("/tmp/legacy", forKey: "taproot.vaultFolder.\(id.uuidString)")

        XCTAssertEqual(store.consumeLegacyVaultFolderPath(for: id), "/tmp/legacy")
        XCTAssertNil(defaults.object(forKey: "taproot.vaultFolder.\(id.uuidString)"),
                     "consumeLegacy must remove the key as a side effect (one-shot migration)")
        XCTAssertNil(store.consumeLegacyVaultFolderPath(for: id),
                     "second call is a no-op + returns nil")
    }

    func testConsumeLegacyVaultFolderPathReturnsNilAndIsNoOpWhenAbsent() {
        let store = SettingsStore(defaults: defaults)
        XCTAssertNil(store.consumeLegacyVaultFolderPath(for: UUID()))
    }

    func testClearVaultBookmarkRemovesBothBookmarkAndLegacyKeys() {
        let store = SettingsStore(defaults: defaults)
        let id = UUID()
        store.setVaultBookmark(Data([0xAB]), for: id)
        defaults.set("/tmp/legacy-too", forKey: "taproot.vaultFolder.\(id.uuidString)")

        store.clearVaultBookmark(for: id)

        XCTAssertNil(store.vaultBookmark(for: id))
        XCTAssertNil(defaults.object(forKey: "taproot.vaultFolder.\(id.uuidString)"))
    }
}
