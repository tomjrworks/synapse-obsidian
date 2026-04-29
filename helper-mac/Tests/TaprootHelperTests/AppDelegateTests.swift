import XCTest
@testable import TaprootHelper

@MainActor
final class AppDelegateTests: XCTestCase {
    private let testService = "com.taproot.helper.tests"
    private var keychain: KeychainStore!
    private var app: AppDelegate!
    /// Class-level fake so the new wire-in tests can read `sendCount` /
    /// `lastRequest` against the same instance the delegate's SyncEngine uses.
    private var fake: FakeHTTPClient!

    override func setUpWithError() throws {
        keychain = KeychainStore(service: testService)
        try keychain.deleteAllForService()
        fake = FakeHTTPClient()
        app = AppDelegate(services: makeServices(keychain: keychain, httpClient: fake))
    }

    override func tearDownWithError() throws {
        try keychain.deleteAllForService()
    }

    private func makeServices(
        keychain: KeychainStore,
        httpClient: HTTPClient = FakeHTTPClient()
    ) -> Services {
        Services(
            keychain: keychain,
            httpClient: httpClient,
            baseURL: URL(string: "http://localhost:0")!,
            now: { Date(timeIntervalSince1970: 0) }
        )
    }

    /// Creates a real disk folder under `temporaryDirectory`, returns its
    /// canonical path. Caller is responsible for cleanup.
    private func makeTempFolder() throws -> URL {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("taproot-appdelegate-tests-\(UUID().uuidString)")
            .resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
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
        let freshApp = AppDelegate(services: makeServices(keychain: keychain))
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

        let freshApp = AppDelegate(services: makeServices(keychain: keychain))
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

    // MARK: - T11.3 wire-in tests

    func testHandleFileChangesPushesToHTTPClient() async throws {
        let id = UUID()
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }

        // Seed workspace bound to the temp folder. We don't go through
        // handleAuthURL because that wires the localFolder via defaultLocalFolder,
        // and we want a deterministic path under tmp for the file-write below.
        app.workspaces = [
            Workspace(
                id: id,
                name: "WS",
                bearer: "test-bearer",
                localFolder: folder,
                lastSyncAt: nil,
                syncStatus: .idle
            )
        ]

        let filePath = folder.appendingPathComponent("note.md")
        try Data("hello".utf8).write(to: filePath)

        let exp = expectation(description: "http send fired")
        await fake.setOnSend { exp.fulfill() }

        app.handleFileChanges(
            workspaceID: id,
            events: [FileChangeEvent(path: filePath, kind: .created, mtime: nil)]
        )

        await fulfillment(of: [exp], timeout: 2.0)

        let count = await fake.sendCount
        XCTAssertEqual(count, 1)
        let lastReq = await fake.lastRequest
        let req = try XCTUnwrap(lastReq)
        XCTAssertTrue(
            req.url.absoluteString.hasSuffix("/api/sync/push"),
            "Expected URL to end with /api/sync/push, got \(req.url.absoluteString)"
        )
        XCTAssertEqual(req.headers["Authorization"], "Bearer test-bearer")
    }

    func testHandleFileChangesDropsEventsForUnknownWorkspace() async throws {
        let unknownID = UUID() // never seeded into app.workspaces
        let event = FileChangeEvent(
            path: URL(fileURLWithPath: "/private/tmp/anything.md"),
            kind: .modified,
            mtime: nil
        )

        app.handleFileChanges(workspaceID: unknownID, events: [event])

        // Give any spurious task a chance to fire. handleFileChanges spawns a
        // Task; for this test, the early-return path runs before the Task is
        // ever spawned, but we wait anyway to catch a regression.
        try await Task.sleep(nanoseconds: 200_000_000)

        let count = await fake.sendCount
        XCTAssertEqual(count, 0, "Unknown workspace ID must not produce HTTP send")
    }

    /// Locks idempotency analysis from plan §4: a 401-fired re-entrant signOut
    /// (via `SyncEngine.onUnauthorized`) overlapping with a direct user signOut
    /// must leave clean state and not crash. KeychainStore.delete tolerates
    /// `errSecItemNotFound`, watchers dict lookup is optional, and removeAll
    /// is no-op on an empty match.
    func testSignOutAfterPushInFlightDoesNotDoubleDelete() async throws {
        let id = UUID()
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }

        // Custom app instance with 401-stubbed fake.
        let localFake = FakeHTTPClient()
        await localFake.setStubbedResponse(
            .success(HTTPResponse(status: 401, body: Data()))
        )
        let testApp = AppDelegate(
            services: makeServices(keychain: keychain, httpClient: localFake)
        )

        // Wire onUnauthorized as production does in applicationDidFinishLaunching.
        await testApp.syncEngine.setOnUnauthorized { [weak testApp] id in
            testApp?.signOut(workspaceID: id)
        }

        // Seed workspace + Keychain + watcher.
        let url = URL(string: "taproot://auth?bearer=in-flight&workspace=\(id.uuidString)")!
        testApp.handleAuthURL(url)
        XCTAssertEqual(testApp.workspaces.count, 1)
        // Override the auto-assigned defaultLocalFolder with our tmp folder.
        testApp.workspaces[0].localFolder = folder
        testApp.startAllWatchers()
        XCTAssertNotNil(testApp.watchers[id])

        // Synchronize on the HTTP send so we know the push entered the engine.
        let sendExp = expectation(description: "push hits server")
        await localFake.setOnSend { sendExp.fulfill() }

        let filePath = folder.appendingPathComponent("note.md")
        try Data("x".utf8).write(to: filePath)

        // Kick the push (engine will receive 401 → fire onUnauthorized → call
        // signOut on MainActor a beat later).
        testApp.handleFileChanges(
            workspaceID: id,
            events: [FileChangeEvent(path: filePath, kind: .created, mtime: nil)]
        )

        // Direct user-driven sign-out runs first on MainActor (synchronous from
        // here). The 401 callback is queued on MainActor and runs after this
        // returns; it must be idempotent.
        testApp.signOut(workspaceID: id)
        XCTAssertTrue(testApp.workspaces.isEmpty, "Direct signOut should have cleaned state")

        // Wait for HTTP send + 401 callback dispatch to settle. Re-entrant
        // signOut from the 401 path runs against an already-empty workspaces
        // array and an already-deleted Keychain entry; both must no-op.
        await fulfillment(of: [sendExp], timeout: 2.0)
        try await Task.sleep(nanoseconds: 200_000_000)

        XCTAssertTrue(testApp.workspaces.isEmpty)
        XCTAssertTrue(testApp.watchers.isEmpty)
        XCTAssertNil(try keychain.retrieve(workspaceID: id))
    }
}
