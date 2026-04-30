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

        // T11.5 commit 3 wires syncStatus around push. Beat for the post-Task
        // .idle flip to land on MainActor before asserting steady state.
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(app.workspaces[0].syncStatus, .idle)
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

    // MARK: - T11.4 pull-poller lifecycle tests

    /// `pullIntervalMs` is read at AppDelegate init from
    /// `TAPROOT_PULL_INTERVAL_MS`. Set the env BEFORE constructing the
    /// AppDelegate so the property initializer captures the test value.
    private func appWithPullInterval(
        ms: Int,
        keychain: KeychainStore,
        httpClient: HTTPClient = FakeHTTPClient()
    ) -> AppDelegate {
        setenv("TAPROOT_PULL_INTERVAL_MS", "\(ms)", 1)
        defer { unsetenv("TAPROOT_PULL_INTERVAL_MS") }
        return AppDelegate(services: makeServices(keychain: keychain, httpClient: httpClient))
    }

    private func cleanCursorDefaults(for id: UUID) {
        UserDefaults.standard.removeObject(forKey: "taproot.lastSync.\(id.uuidString)")
        UserDefaults.standard.removeObject(forKey: "taproot.lastSyncId.\(id.uuidString)")
    }

    private func cleanSettingsDefaults(for id: UUID) {
        UserDefaults.standard.removeObject(forKey: "taproot.pausedOnLaunch.\(id.uuidString)")
    }

    func testStartPullPollerRunsTickAndAdvancesCursor() async throws {
        let id = UUID()
        defer { cleanCursorDefaults(for: id) }

        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }

        let cursorMtime = "2026-04-29T05:00:00.000Z"
        let cursorId = "00000000-0000-4000-8000-000000000001"
        let json = """
        {"files":[{"path":"hello.md","size":5,"mtime":"\(cursorMtime)","deleted":false,"content":"hello"}],
         "next_since":"\(cursorMtime)","next_since_id":"\(cursorId)"}
        """
        let localFake = FakeHTTPClient()
        await localFake.setStubbedResponse(.success(HTTPResponse(status: 200, body: Data(json.utf8))))

        let testApp = appWithPullInterval(ms: 200, keychain: keychain, httpClient: localFake)
        testApp.workspaces = [
            Workspace(
                id: id,
                name: "WS",
                bearer: "test-bearer",
                localFolder: folder,
                lastSyncAt: nil,
                syncStatus: .idle
            )
        ]

        let exp = expectation(description: "first pull tick fired")
        exp.assertForOverFulfill = false  // poller keeps ticking; we only care about the first fire
        await localFake.setOnSend { exp.fulfill() }

        testApp.startAllPullPollers()
        await fulfillment(of: [exp], timeout: 2.0)

        // Give the post-send work (cursor persist) a chance to run on @MainActor.
        try await Task.sleep(nanoseconds: 300_000_000)

        XCTAssertEqual(testApp.pullCursors[id]?.modifiedAt, cursorMtime)
        XCTAssertEqual(testApp.pullCursors[id]?.id, cursorId)
        XCTAssertEqual(
            UserDefaults.standard.string(forKey: "taproot.lastSync.\(id.uuidString)"),
            cursorMtime
        )
        XCTAssertEqual(
            UserDefaults.standard.string(forKey: "taproot.lastSyncId.\(id.uuidString)"),
            cursorId
        )

        testApp.stopPullPoller(for: id)
    }

    func testSignOutCancelsPullPollerAndClearsCursor() async throws {
        let id = UUID()
        defer { cleanCursorDefaults(for: id) }

        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }

        let cursorMtime = "2026-04-29T05:00:00.000Z"
        let cursorId = "00000000-0000-4000-8000-000000000001"
        let json = """
        {"files":[{"path":"hello.md","size":5,"mtime":"\(cursorMtime)","deleted":false,"content":"hello"}],
         "next_since":"\(cursorMtime)","next_since_id":"\(cursorId)"}
        """
        let localFake = FakeHTTPClient()
        await localFake.setStubbedResponse(.success(HTTPResponse(status: 200, body: Data(json.utf8))))

        let testApp = appWithPullInterval(ms: 200, keychain: keychain, httpClient: localFake)
        try keychain.store(workspaceID: id, bearer: "to-clear")
        testApp.workspaces = [
            Workspace(
                id: id,
                name: "WS",
                bearer: "to-clear",
                localFolder: folder,
                lastSyncAt: nil,
                syncStatus: .idle
            )
        ]

        let exp = expectation(description: "first pull tick fired")
        exp.assertForOverFulfill = false  // poller keeps ticking; we only care about the first fire
        await localFake.setOnSend { exp.fulfill() }

        testApp.startAllPullPollers()
        await fulfillment(of: [exp], timeout: 2.0)
        try await Task.sleep(nanoseconds: 200_000_000)

        XCTAssertNotNil(testApp.pullPollers[id])
        XCTAssertNotNil(UserDefaults.standard.string(forKey: "taproot.lastSync.\(id.uuidString)"))

        let sendsBeforeSignOut = await localFake.sendCount
        testApp.signOut(workspaceID: id)

        XCTAssertNil(testApp.pullPollers[id], "signOut must remove poller from dict")
        XCTAssertNil(testApp.pullCursors[id], "signOut must clear in-memory cursor")
        XCTAssertNil(UserDefaults.standard.string(forKey: "taproot.lastSync.\(id.uuidString)"))
        XCTAssertNil(UserDefaults.standard.string(forKey: "taproot.lastSyncId.\(id.uuidString)"))

        // Give any in-flight tick a generous beat to finish + verify no NEW
        // sends fire after sign-out.
        try await Task.sleep(nanoseconds: 500_000_000)
        let sendsAfter = await localFake.sendCount
        XCTAssertLessThanOrEqual(
            sendsAfter,
            sendsBeforeSignOut + 1,
            "no new pull sends after signOut (allow 1 in-flight tick that started before cancel)"
        )
    }

    func testPullTickD5CapBoundsDrain() async throws {
        let id = UUID()
        defer { cleanCursorDefaults(for: id) }

        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }

        // Generate a JSON page with `files.count == 500` so engine.pull's
        // ">= limit" check fires every iteration → drain loop hits the cap.
        // Each entry has a unique mtime so cursor strictly advances; cap exit
        // is what stops the loop, NOT exhausting the page.
        var entries: [String] = []
        entries.reserveCapacity(500)
        for i in 0..<500 {
            // Unique mtime per row keeps the cursor monotonic; deterministic.
            let mm = String(format: "%02d", i / 60)
            let ss = String(format: "%02d", i % 60)
            entries.append(
                "{\"path\":\"f\(i).md\",\"size\":1,\"mtime\":\"2026-04-29T05:\(mm):\(ss).000Z\",\"deleted\":false,\"content\":\"x\"}"
            )
        }
        let nextMtime = "2026-04-29T05:08:19.000Z"  // last row's mtime
        let nextId = "00000000-0000-4000-8000-000000000500"
        let json = "{\"files\":[\(entries.joined(separator: ","))]," +
            "\"next_since\":\"\(nextMtime)\",\"next_since_id\":\"\(nextId)\"}"

        let localFake = FakeHTTPClient()
        await localFake.setStubbedResponse(.success(HTTPResponse(status: 200, body: Data(json.utf8))))

        // Default 30s interval is fine; we drive pullTick directly so the
        // background poller never fires under us.
        let testApp = AppDelegate(services: makeServices(keychain: keychain, httpClient: localFake))
        testApp.workspaces = [
            Workspace(
                id: id,
                name: "WS",
                bearer: "test-bearer",
                localFolder: folder,
                lastSyncAt: nil,
                syncStatus: .idle
            )
        ]

        await testApp.pullTick(workspaceID: id)

        let sendCount = await localFake.sendCount
        XCTAssertEqual(
            sendCount,
            AppDelegate.maxDrainPagesPerTick,
            "drain must hit D5 cap exactly (\(AppDelegate.maxDrainPagesPerTick) sends)"
        )
        XCTAssertEqual(testApp.pullCursors[id]?.modifiedAt, nextMtime)
        XCTAssertEqual(testApp.pullCursors[id]?.id, nextId)
        XCTAssertEqual(
            UserDefaults.standard.string(forKey: "taproot.lastSync.\(id.uuidString)"),
            nextMtime
        )
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

    // MARK: - T11.5 commit 4 (sign-out + pause + open-folder)

    func testPerformSignOutMatchesSignOutBehavior() throws {
        let id = UUID()
        let url = URL(string: "taproot://auth?bearer=to-clear&workspace=\(id.uuidString)")!
        app.handleAuthURL(url)
        XCTAssertEqual(app.workspaces.count, 1)

        app.performSignOut(workspaceID: id)

        XCTAssertNil(try keychain.retrieve(workspaceID: id))
        XCTAssertTrue(app.workspaces.isEmpty)
    }

    func testMenuSignOutSkipsWhenConfirmDeclined() throws {
        let id = UUID()
        app.handleAuthURL(URL(string: "taproot://auth?bearer=keep&workspace=\(id.uuidString)")!)
        XCTAssertEqual(app.workspaces.count, 1)

        app.confirmSignOut = { _ in false }

        let item = NSMenuItem(title: "Sign out", action: nil, keyEquivalent: "")
        item.representedObject = id
        app.menuSignOut(item)

        XCTAssertEqual(app.workspaces.count, 1, "Cancelled confirm leaves workspace in place")
        XCTAssertEqual(try keychain.retrieve(workspaceID: id), "keep")
    }

    func testMenuSignOutInvokesPerformWhenConfirmed() throws {
        let id = UUID()
        app.handleAuthURL(URL(string: "taproot://auth?bearer=remove&workspace=\(id.uuidString)")!)
        XCTAssertEqual(app.workspaces.count, 1)

        app.confirmSignOut = { _ in true }

        let item = NSMenuItem(title: "Sign out", action: nil, keyEquivalent: "")
        item.representedObject = id
        app.menuSignOut(item)

        XCTAssertTrue(app.workspaces.isEmpty)
        XCTAssertNil(try keychain.retrieve(workspaceID: id))
    }

    func testPauseToggleStopsWatcherAndPoller() throws {
        let id = UUID()
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        defer { cleanSettingsDefaults(for: id) }

        app.workspaces = [
            Workspace(
                id: id,
                name: "WS",
                bearer: "b",
                localFolder: folder,
                lastSyncAt: nil,
                syncStatus: .idle
            )
        ]
        app.startAllWatchers()
        app.startAllPullPollers()
        XCTAssertNotNil(app.watchers[id])
        XCTAssertNotNil(app.pullPollers[id])

        app.togglePauseSync(workspaceID: id)

        XCTAssertNil(app.watchers[id])
        XCTAssertNil(app.pullPollers[id])
        XCTAssertEqual(app.workspaces[0].syncStatus, .paused)
    }

    func testPauseMenuItemTitleReflectsStatus() {
        let id = UUID()
        let pausedWS = Workspace(
            id: id,
            name: "WS",
            bearer: "b",
            localFolder: URL(fileURLWithPath: "/tmp/ws"),
            lastSyncAt: nil,
            syncStatus: .paused
        )

        let menu = app.buildMenu(for: [pausedWS])

        // Flat layout: name, Open vault folder, Pause/Resume, Settings…, Sign out, sep, Quit.
        XCTAssertEqual(menu.items[2].title, "Resume sync")
    }

    func testBuildMenuShowsLastErrorWhenStatusIsError() {
        let id = UUID()
        let erroredWS = Workspace(
            id: id,
            name: "WS",
            bearer: "b",
            localFolder: URL(fileURLWithPath: "/tmp/ws"),
            lastSyncAt: nil,
            syncStatus: .error("transport")
        )

        let menu = app.buildMenu(for: [erroredWS])

        // Looking for a disabled "Last error: transport" item somewhere in the menu.
        let errorItem = menu.items.first { $0.title == "Last error: transport" }
        XCTAssertNotNil(errorItem, "Error status should surface a disabled 'Last error' item")
        XCTAssertEqual(errorItem?.isEnabled, false)
    }

    func testResumeRestartsWatcherAndPoller() throws {
        let id = UUID()
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        defer { cleanSettingsDefaults(for: id) }

        app.workspaces = [
            Workspace(
                id: id,
                name: "WS",
                bearer: "b",
                localFolder: folder,
                lastSyncAt: nil,
                syncStatus: .idle
            )
        ]
        app.startAllWatchers()
        app.startAllPullPollers()

        app.togglePauseSync(workspaceID: id)
        XCTAssertEqual(app.workspaces[0].syncStatus, .paused)

        app.togglePauseSync(workspaceID: id)

        XCTAssertNotNil(app.watchers[id])
        XCTAssertNotNil(app.pullPollers[id])
        XCTAssertEqual(app.workspaces[0].syncStatus, .idle)
        // Cleanup.
        app.watchers.values.forEach { $0.stop() }
        app.stopPullPoller(for: id)
    }

    func testTogglePauseWritesPausedOnLaunchKey() throws {
        let id = UUID()
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        defer { cleanSettingsDefaults(for: id) }

        app.workspaces = [
            Workspace(
                id: id,
                name: "WS",
                bearer: "b",
                localFolder: folder,
                lastSyncAt: nil,
                syncStatus: .idle
            )
        ]
        app.startAllWatchers()
        app.startAllPullPollers()

        app.togglePauseSync(workspaceID: id)

        XCTAssertTrue(
            UserDefaults.standard.bool(forKey: "taproot.pausedOnLaunch.\(id.uuidString)"),
            "Pausing must persist a per-workspace flag so a relaunch resumes paused"
        )
    }

    func testToggleResumeClearsPausedOnLaunchKey() throws {
        let id = UUID()
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        defer { cleanSettingsDefaults(for: id) }

        app.workspaces = [
            Workspace(
                id: id,
                name: "WS",
                bearer: "b",
                localFolder: folder,
                lastSyncAt: nil,
                syncStatus: .idle
            )
        ]
        app.startAllWatchers()
        app.startAllPullPollers()

        app.togglePauseSync(workspaceID: id) // pause
        XCTAssertTrue(UserDefaults.standard.bool(forKey: "taproot.pausedOnLaunch.\(id.uuidString)"))

        app.togglePauseSync(workspaceID: id) // resume

        XCTAssertNil(
            UserDefaults.standard.object(forKey: "taproot.pausedOnLaunch.\(id.uuidString)"),
            "Resume must remove the paused-on-launch flag, not leave a `false` value"
        )
        // Cleanup.
        app.watchers.values.forEach { $0.stop() }
        app.stopPullPoller(for: id)
    }

    func testSignOutClearsPausedOnLaunchKey() throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        app.handleAuthURL(URL(string: "taproot://auth?bearer=clear-me&workspace=\(id.uuidString)")!)

        app.togglePauseSync(workspaceID: id)
        XCTAssertTrue(UserDefaults.standard.bool(forKey: "taproot.pausedOnLaunch.\(id.uuidString)"))

        app.signOut(workspaceID: id)

        XCTAssertNil(
            UserDefaults.standard.object(forKey: "taproot.pausedOnLaunch.\(id.uuidString)"),
            "Sign-out must clear paused-on-launch so re-auth starts unpaused"
        )
    }

    func testApplicationDidFinishLaunchingResumesPausedWorkspaceAsPaused() throws {
        let id = UUID()
        try keychain.store(workspaceID: id, bearer: "bearer-paused")
        UserDefaults.standard.set(true, forKey: "taproot.pausedOnLaunch.\(id.uuidString)")
        defer { cleanSettingsDefaults(for: id) }

        // Fresh delegate sharing the same keychain (simulates app relaunch).
        let freshApp = AppDelegate(services: makeServices(keychain: keychain))
        freshApp.loadWorkspacesFromKeychain()
        freshApp.resumePausedFromUserDefaults()
        freshApp.startAllWatchers()
        freshApp.startAllPullPollers()

        XCTAssertEqual(freshApp.workspaces.first?.syncStatus, .paused)
        XCTAssertNil(freshApp.watchers[id], "Paused workspace must not start a watcher on launch")
        XCTAssertNil(freshApp.pullPollers[id], "Paused workspace must not start a poller on launch")
    }

    // MARK: - T11.5 menu builder tests

    func testBuildMenuShowsNotSignedInForZeroWorkspaces() {
        let menu = app.buildMenu(for: [])

        XCTAssertEqual(menu.items.count, 3, "Zero-workspace menu shape: [Not signed in, separator, Quit]")

        let label = menu.items[0]
        XCTAssertEqual(label.title, "Not signed in")
        XCTAssertFalse(label.isEnabled, "'Not signed in' is a disabled label, not a clickable action")

        XCTAssertTrue(menu.items[1].isSeparatorItem)

        XCTAssertEqual(menu.items[2].title, "Quit")
    }

    func testBuildMenuFlatLayoutForSingleWorkspace() throws {
        let id = UUID()
        let workspace = Workspace(
            id: id,
            name: "WS",
            bearer: "b",
            localFolder: URL(fileURLWithPath: "/tmp/ws"),
            lastSyncAt: nil,
            syncStatus: .idle
        )

        let menu = app.buildMenu(for: [workspace])

        // Shape: [name (disabled), Open vault folder, Pause sync, Settings…,
        //         Sign out, separator, Quit] = 7 items.
        XCTAssertEqual(menu.items.count, 7)

        XCTAssertEqual(menu.items[0].title, "WS")
        XCTAssertFalse(menu.items[0].isEnabled, "Workspace name row is a disabled label")

        let openFolder = menu.items[1]
        XCTAssertEqual(openFolder.title, "Open vault folder")
        XCTAssertEqual(openFolder.representedObject as? UUID, id)

        let pauseSync = menu.items[2]
        XCTAssertEqual(pauseSync.title, "Pause sync")
        XCTAssertEqual(pauseSync.representedObject as? UUID, id)

        let settings = menu.items[3]
        XCTAssertEqual(settings.title, "Settings…")
        XCTAssertTrue(settings.isEnabled, "Settings… enabled in T11.6")
        XCTAssertEqual(settings.action, #selector(AppDelegate.menuOpenSettings(_:)))

        let signOut = menu.items[4]
        XCTAssertEqual(signOut.title, "Sign out")
        XCTAssertEqual(signOut.representedObject as? UUID, id)

        XCTAssertTrue(menu.items[5].isSeparatorItem)

        XCTAssertEqual(menu.items[6].title, "Quit")
    }

    func testBuildMenuNestedLayoutForTwoWorkspaces() throws {
        let id1 = UUID()
        let id2 = UUID()
        let ws1 = Workspace(
            id: id1,
            name: "Alpha",
            bearer: "b1",
            localFolder: URL(fileURLWithPath: "/tmp/a"),
            lastSyncAt: nil,
            syncStatus: .idle
        )
        let ws2 = Workspace(
            id: id2,
            name: "Beta",
            bearer: "b2",
            localFolder: URL(fileURLWithPath: "/tmp/b"),
            lastSyncAt: nil,
            syncStatus: .idle
        )

        let menu = app.buildMenu(for: [ws1, ws2])

        // Nested shape: [ws1 > submenu, ws2 > submenu, separator, Quit] = 4 items.
        XCTAssertEqual(menu.items.count, 4)

        XCTAssertEqual(menu.items[0].title, "Alpha")
        let alphaSubmenu = try XCTUnwrap(menu.items[0].submenu)
        XCTAssertEqual(menu.items[1].title, "Beta")
        let betaSubmenu = try XCTUnwrap(menu.items[1].submenu)

        XCTAssertTrue(menu.items[2].isSeparatorItem)
        XCTAssertEqual(menu.items[3].title, "Quit")

        // Each submenu carries the 4 per-workspace actions, no name-label
        // (the top-level row already labels which workspace).
        XCTAssertEqual(alphaSubmenu.items.count, 4)
        XCTAssertEqual(alphaSubmenu.items[0].title, "Open vault folder")
        XCTAssertEqual(alphaSubmenu.items[0].representedObject as? UUID, id1)
        XCTAssertEqual(alphaSubmenu.items[1].title, "Pause sync")
        XCTAssertEqual(alphaSubmenu.items[1].representedObject as? UUID, id1)
        XCTAssertEqual(alphaSubmenu.items[2].title, "Settings…")
        XCTAssertTrue(alphaSubmenu.items[2].isEnabled)
        XCTAssertEqual(alphaSubmenu.items[3].title, "Sign out")
        XCTAssertEqual(alphaSubmenu.items[3].representedObject as? UUID, id1)

        // Beta submenu items are pinned to ws2.id.
        XCTAssertEqual(betaSubmenu.items[0].representedObject as? UUID, id2)
        XCTAssertEqual(betaSubmenu.items[3].representedObject as? UUID, id2)
    }

    func testPullTickFlipsSyncStatusToSyncingThenIdle() async throws {
        let id = UUID()
        defer { cleanCursorDefaults(for: id) }

        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }

        // One row, no further pages. Drain hits .caughtUp on first iteration.
        let cursorMtime = "2026-04-29T05:00:00.000Z"
        let cursorId = "00000000-0000-4000-8000-000000000001"
        let json = """
        {"files":[{"path":"hello.md","size":5,"mtime":"\(cursorMtime)","deleted":false,"content":"hello"}],
         "next_since":"\(cursorMtime)","next_since_id":"\(cursorId)"}
        """
        let localFake = FakeHTTPClient()
        await localFake.setStubbedResponse(.success(HTTPResponse(status: 200, body: Data(json.utf8))))

        let testApp = AppDelegate(services: makeServices(keychain: keychain, httpClient: localFake))
        testApp.workspaces = [
            Workspace(
                id: id,
                name: "WS",
                bearer: "test-bearer",
                localFolder: folder,
                lastSyncAt: nil,
                syncStatus: .idle
            )
        ]

        // Capture every status the workspace passes through during the tick.
        var statusHistory: [SyncStatus] = []
        testApp.workspaceMutationObserver = { wks in
            if let s = wks.first(where: { $0.id == id })?.syncStatus {
                statusHistory.append(s)
            }
        }

        XCTAssertEqual(testApp.workspaces[0].syncStatus, .idle, "Pre: idle")

        await testApp.pullTick(workspaceID: id)

        XCTAssertEqual(
            statusHistory,
            [.syncing, .idle],
            "pullTick must flip status .syncing then back to .idle on a clean drain"
        )
        XCTAssertEqual(testApp.workspaces[0].syncStatus, .idle, "Post: idle")
    }

    func testHandleFileChangesFlipsSyncStatusAroundPush() async throws {
        let id = UUID()
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }

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

        var statusHistory: [SyncStatus] = []
        app.workspaceMutationObserver = { wks in
            if let s = wks.first(where: { $0.id == id })?.syncStatus {
                statusHistory.append(s)
            }
        }

        let filePath = folder.appendingPathComponent("note.md")
        try Data("hello".utf8).write(to: filePath)

        let exp = expectation(description: "http send fired")
        await fake.setOnSend { exp.fulfill() }

        app.handleFileChanges(
            workspaceID: id,
            events: [FileChangeEvent(path: filePath, kind: .created, mtime: nil)]
        )

        await fulfillment(of: [exp], timeout: 2.0)
        // Beat for the post-Task .idle flip to land on MainActor.
        try await Task.sleep(nanoseconds: 200_000_000)

        XCTAssertEqual(statusHistory, [.syncing, .idle])
        XCTAssertEqual(app.workspaces[0].syncStatus, .idle)
    }

    func testPullTickTransportErrorSetsErrorStatus() async throws {
        let id = UUID()
        defer { cleanCursorDefaults(for: id) }

        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }

        let localFake = FakeHTTPClient()
        await localFake.setStubbedResponse(.success(HTTPResponse(status: 500, body: Data())))

        let testApp = AppDelegate(services: makeServices(keychain: keychain, httpClient: localFake))
        testApp.workspaces = [
            Workspace(
                id: id,
                name: "WS",
                bearer: "test-bearer",
                localFolder: folder,
                lastSyncAt: nil,
                syncStatus: .idle
            )
        ]

        await testApp.pullTick(workspaceID: id)

        XCTAssertEqual(testApp.workspaces[0].syncStatus, .error("transport"))
    }

    func testRebuildMenuFiresOnSignOut() throws {
        let id1 = UUID()
        let id2 = UUID()
        app.handleAuthURL(URL(string: "taproot://auth?bearer=a&workspace=\(id1.uuidString)")!)
        app.handleAuthURL(URL(string: "taproot://auth?bearer=b&workspace=\(id2.uuidString)")!)
        XCTAssertEqual(app.currentMenu?.items.count, 4, "Pre-signOut: nested 4-item menu")

        app.signOut(workspaceID: id2)

        // After sign-out the count drops to 1 → flat 7-item shape.
        let after = try XCTUnwrap(app.currentMenu)
        XCTAssertEqual(after.items.count, 7)
    }

    func testRebuildMenuFiresOnHandleAuthURL() throws {
        let id1 = UUID()
        let id2 = UUID()
        app.handleAuthURL(URL(string: "taproot://auth?bearer=a&workspace=\(id1.uuidString)")!)

        // After 1 workspace, currentMenu reflects the 7-item flat shape.
        let afterFirst = try XCTUnwrap(app.currentMenu)
        XCTAssertEqual(afterFirst.items.count, 7, "Flat layout after first auth")

        app.handleAuthURL(URL(string: "taproot://auth?bearer=b&workspace=\(id2.uuidString)")!)

        // After 2 workspaces, currentMenu reflects the 4-item nested shape.
        let afterSecond = try XCTUnwrap(app.currentMenu)
        XCTAssertEqual(afterSecond.items.count, 4, "Nested layout after second auth")
        XCTAssertNotNil(afterSecond.items[0].submenu)
        XCTAssertNotNil(afterSecond.items[1].submenu)
        XCTAssertTrue(afterSecond.items[2].isSeparatorItem)
        XCTAssertEqual(afterSecond.items[3].title, "Quit")
    }

    func testStatusIconPrecedence() {
        func ws(_ status: SyncStatus) -> Workspace {
            Workspace(
                id: UUID(),
                name: "WS",
                bearer: "b",
                localFolder: URL(fileURLWithPath: "/tmp/ws"),
                lastSyncAt: nil,
                syncStatus: status
            )
        }

        // Empty + all-idle → leaf.
        XCTAssertEqual(app.statusIconName(for: []), "leaf.fill")
        XCTAssertEqual(app.statusIconName(for: [ws(.idle)]), "leaf.fill")
        XCTAssertEqual(app.statusIconName(for: [ws(.idle), ws(.idle)]), "leaf.fill")

        // .paused beats .idle.
        XCTAssertEqual(app.statusIconName(for: [ws(.idle), ws(.paused)]), "pause.fill")

        // .syncing beats .paused + .idle.
        XCTAssertEqual(
            app.statusIconName(for: [ws(.paused), ws(.syncing), ws(.idle)]),
            "arrow.triangle.2.circlepath"
        )

        // .error beats everything.
        XCTAssertEqual(
            app.statusIconName(for: [ws(.syncing), ws(.error("transport"))]),
            "exclamationmark.triangle.fill"
        )
        XCTAssertEqual(
            app.statusIconName(for: [ws(.paused), ws(.error("x")), ws(.syncing), ws(.idle)]),
            "exclamationmark.triangle.fill"
        )
    }

    // MARK: - T11.6 settings tests

    func testPresentSettingsClosureSeamCanBeInjected() {
        var fired = false
        app.presentSettings = { fired = true }

        app.presentSettings()

        XCTAssertTrue(fired, "Tests must be able to inject a stub for the settings-window seam")
    }

    func testNotificationsToggleRoundTripsViaSettingsStore() {
        let suite = "test-\(UUID().uuidString)"
        defer { UserDefaults().removePersistentDomain(forName: suite) }

        var store = SettingsStore(defaults: UserDefaults(suiteName: suite)!)
        store.notificationsEnabled = true

        XCTAssertTrue(
            SettingsStore(defaults: UserDefaults(suiteName: suite)!).notificationsEnabled,
            "Notifications toggle must persist to the underlying UserDefaults suite"
        )
    }

    func testMenuOpenSettingsInvokesPresentSettings() {
        var fired = false
        app.presentSettings = { fired = true }

        let item = NSMenuItem(title: "Settings…", action: nil, keyEquivalent: "")
        app.menuOpenSettings(item)

        XCTAssertTrue(fired)
    }

    func testRevealInFinderClosureSeamCanBeInjected() {
        var captured: URL?
        app.revealInFinder = { captured = $0 }

        let url = URL(fileURLWithPath: "/tmp/test")
        app.revealInFinder(url)

        XCTAssertEqual(captured, url)
    }

    func testOpenSyncLogClosureSeamCanBeInjected() {
        var fired = false
        app.openSyncLog = { fired = true }

        app.openSyncLog()

        XCTAssertTrue(fired)
    }

    func testResolveVersionLabelReadsBundleShortVersion() {
        let v = AppDelegate.resolveVersionLabel(bundleLookup: { key in
            key == "CFBundleShortVersionString" ? "1.2.3" : nil
        })
        XCTAssertEqual(v, "1.2.3")
    }

    func testResolveVersionLabelFallsBackToDev() {
        let v = AppDelegate.resolveVersionLabel(bundleLookup: { _ in nil })
        XCTAssertEqual(v, "dev")
    }

    func testDefaultLocalFolderUsesSlugWhenProvided() {
        let id = UUID()
        let url = app.defaultLocalFolder(for: id, slug: "toms-vault")
        XCTAssertTrue(
            url.path.hasSuffix("Taproot/toms-vault"),
            "expected suffix Taproot/toms-vault, got \(url.path)"
        )
    }

    func testDefaultLocalFolderFallsBackToUUIDWhenSlugNil() {
        let id = UUID()
        let url = app.defaultLocalFolder(for: id, slug: nil)
        XCTAssertTrue(
            url.path.hasSuffix("Taproot/\(id.uuidString)"),
            "expected suffix Taproot/<uuid>, got \(url.path)"
        )
    }
}
