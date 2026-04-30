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

    func testAutomaticallyInstallsUpdatesDefaultsFalse() {
        let store = SettingsStore(defaults: defaults)
        XCTAssertFalse(store.automaticallyInstallsUpdates,
                       "L1 default: prompt-first install behavior")
    }

    func testAutomaticallyInstallsUpdatesRoundTrips() {
        var store = SettingsStore(defaults: defaults)
        store.automaticallyInstallsUpdates = true
        XCTAssertTrue(SettingsStore(defaults: defaults).automaticallyInstallsUpdates)
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

    func testVaultFolderRoundTrips() {
        let store = SettingsStore(defaults: defaults)
        let id = UUID()
        let url = URL(fileURLWithPath: "/tmp/x")

        store.setVaultFolder(url, for: id)

        XCTAssertEqual(
            SettingsStore(defaults: defaults).vaultFolder(for: id)?.absoluteString,
            url.absoluteString
        )
    }

    func testVaultFolderDefaultsNilForUnknown() {
        let store = SettingsStore(defaults: defaults)
        XCTAssertNil(store.vaultFolder(for: UUID()))
    }

    /// N10 (build-audit-3): vaultFolder reads via URL(fileURLWithPath:) so a
    /// corrupted or injected UserDefaults value (e.g., an http URL) is
    /// coerced into a file URL with a junk path rather than ever returning a
    /// non-file URL to the AppDelegate.
    func testVaultFolderCoercesNonFileSchemeToFileURL() throws {
        let store = SettingsStore(defaults: defaults)
        let id = UUID()
        defaults.set("http://evil.example/x", forKey: "taproot.vaultFolder.\(id.uuidString)")

        let url = try XCTUnwrap(store.vaultFolder(for: id))

        XCTAssertTrue(url.isFileURL,
                      "vaultFolder must always return a file URL, got \(url.absoluteString)")
        XCTAssertNotEqual(url.scheme, "http")
    }

    func testClearVaultFolderRemovesKey() {
        let store = SettingsStore(defaults: defaults)
        let id = UUID()
        store.setVaultFolder(URL(fileURLWithPath: "/tmp/x"), for: id)
        XCTAssertNotNil(store.vaultFolder(for: id))

        store.clearVaultFolder(for: id)

        XCTAssertNil(store.vaultFolder(for: id))
        XCTAssertNil(defaults.object(forKey: "taproot.vaultFolder.\(id.uuidString)"))
    }
}
