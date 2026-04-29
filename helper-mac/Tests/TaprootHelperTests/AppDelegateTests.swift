import XCTest
@testable import TaprootHelper

@MainActor
final class AppDelegateTests: XCTestCase {
    private let testService = "com.taproot.helper.tests"
    private var keychain: KeychainStore!
    private var app: AppDelegate!

    override func setUpWithError() throws {
        keychain = KeychainStore(service: testService)
        try keychain.deleteAllForService()
        app = AppDelegate(keychain: keychain)
    }

    override func tearDownWithError() throws {
        try keychain.deleteAllForService()
    }

    func testHandleAuthURLAddsNewWorkspace() throws {
        let id = UUID()
        let url = URL(string: "taproot://auth?bearer=integration-test&workspace=\(id.uuidString)")!

        app.handleAuthURL(url)

        XCTAssertEqual(try keychain.retrieve(workspaceID: id), "integration-test")
        XCTAssertEqual(app.workspaces.count, 1)
        XCTAssertEqual(app.workspaces.first?.id, id)
        XCTAssertEqual(app.workspaces.first?.bearer, "integration-test")
    }

    func testHandleAuthURLOverwritesExistingWorkspace() throws {
        let id = UUID()
        let firstURL = URL(string: "taproot://auth?bearer=first&workspace=\(id.uuidString)")!
        let secondURL = URL(string: "taproot://auth?bearer=second&workspace=\(id.uuidString)")!

        app.handleAuthURL(firstURL)
        app.handleAuthURL(secondURL)

        XCTAssertEqual(app.workspaces.count, 1, "Same workspace ID should not duplicate")
        XCTAssertEqual(try keychain.retrieve(workspaceID: id), "second")
        XCTAssertEqual(app.workspaces.first?.bearer, "second")
    }

    func testHandleAuthURLIgnoresMalformedURL() throws {
        let badURL = URL(string: "https://example.com/foo")!
        app.handleAuthURL(badURL)

        XCTAssertTrue(app.workspaces.isEmpty)
        XCTAssertEqual(try keychain.retrieveAll().count, 0)
    }

    func testSignOutClearsKeychainAndRemovesWorkspace() throws {
        let id = UUID()
        let url = URL(string: "taproot://auth?bearer=to-clear&workspace=\(id.uuidString)")!
        app.handleAuthURL(url)
        XCTAssertEqual(app.workspaces.count, 1)

        app.signOut(workspaceID: id)

        XCTAssertNil(try keychain.retrieve(workspaceID: id))
        XCTAssertTrue(app.workspaces.isEmpty)
    }

    func testSignOutOnlyAffectsTargetWorkspace() throws {
        let id1 = UUID()
        let id2 = UUID()
        app.handleAuthURL(URL(string: "taproot://auth?bearer=keep&workspace=\(id1.uuidString)")!)
        app.handleAuthURL(URL(string: "taproot://auth?bearer=remove&workspace=\(id2.uuidString)")!)

        app.signOut(workspaceID: id2)

        XCTAssertEqual(app.workspaces.count, 1)
        XCTAssertEqual(app.workspaces.first?.id, id1)
        XCTAssertEqual(try keychain.retrieve(workspaceID: id1), "keep")
        XCTAssertNil(try keychain.retrieve(workspaceID: id2))
    }

    func testLoadWorkspacesFromKeychain() throws {
        let id1 = UUID()
        let id2 = UUID()
        try keychain.store(workspaceID: id1, bearer: "bearer-1")
        try keychain.store(workspaceID: id2, bearer: "bearer-2")

        // Fresh delegate sharing the same keychain (simulates app relaunch).
        let freshApp = AppDelegate(keychain: keychain)
        freshApp.loadWorkspacesFromKeychain()

        XCTAssertEqual(freshApp.workspaces.count, 2)
        let bearers = freshApp.workspaces.map { $0.bearer }.sorted()
        XCTAssertEqual(bearers, ["bearer-1", "bearer-2"])
    }

    func testStartAllWatchersStartsOnePerLoadedWorkspace() throws {
        let id1 = UUID()
        let id2 = UUID()
        try keychain.store(workspaceID: id1, bearer: "bearer-1")
        try keychain.store(workspaceID: id2, bearer: "bearer-2")

        let freshApp = AppDelegate(keychain: keychain)
        freshApp.loadWorkspacesFromKeychain()
        freshApp.startAllWatchers()

        XCTAssertEqual(freshApp.watchers.count, 2)
        XCTAssertNotNil(freshApp.watchers[id1])
        XCTAssertNotNil(freshApp.watchers[id2])

        // Cleanup: stop watchers (defaultLocalFolder paths likely don't exist,
        // so they're idle no-ops, but stop() is still required for tidy teardown).
        freshApp.watchers.values.forEach { $0.stop() }
    }

    func testSignOutStopsAndRemovesWatcher() throws {
        let id = UUID()
        let url = URL(string: "taproot://auth?bearer=watch-me&workspace=\(id.uuidString)")!
        app.handleAuthURL(url)
        app.startAllWatchers()
        XCTAssertNotNil(app.watchers[id])

        app.signOut(workspaceID: id)

        XCTAssertNil(app.watchers[id])
        XCTAssertTrue(app.workspaces.isEmpty)
    }
}
