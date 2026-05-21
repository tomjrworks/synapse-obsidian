import XCTest
@testable import TaprootHelper

// Valid 32-char bearers for handleAuthURL test fixtures.
// Bearers shorter than 32 chars are now rejected by DeepLinkParser (M5 hardening).
private let kBearerA = "integration-test" + String(repeating: "0", count: 16)  // 32 chars
private let kBearerB = "second" + String(repeating: "0", count: 26)             // 32 chars
private let kBearerNew = "new" + String(repeating: "0", count: 29)              // 32 chars
private let kBearerKeep = "keep" + String(repeating: "0", count: 28)            // 32 chars
private let kBearerRemove = "remove" + String(repeating: "0", count: 26)        // 32 chars
private let kBearerToClear = "to-clear" + String(repeating: "0", count: 24)     // 32 chars
private let kBearerWatchMe = "watch-me" + String(repeating: "0", count: 24)     // 32 chars
private let kBearerInFlight = "in-flight" + String(repeating: "0", count: 23)   // 32 chars
private let kBearerClearMe = "clear-me" + String(repeating: "0", count: 24)     // 32 chars
private let kBearerAlpha = "a" + String(repeating: "0", count: 31)              // 32 chars
private let kBearerBravo = "b" + String(repeating: "0", count: 31)              // 32 chars
private let kBearerAttacker = "attacker" + String(repeating: "0", count: 24)    // 32 chars
private let kBearerBig = "B" + String(repeating: "0", count: 31)                // 32 chars

@MainActor
final class AppDelegateTests: XCTestCase {
    private let testService = "com.taproot.helper.tests"
    private var keychain: KeychainStore!
    private var app: AppDelegate!
    /// Class-level fake so the new wire-in tests can read `sendCount` /
    /// `lastRequest` against the same instance the delegate's SyncEngine uses.
    private var fake: FakeHTTPClient!

    override func setUpWithError() throws {
        // Force NSApp init for test paths that touch NSApp.activate /
        // NSApplication.shared (e.g., the T11.7 wired presentFirstRun
        // chain). Production gets NSApp via main.swift's
        // NSApplication.shared.run(); xctest doesn't run that.
        _ = NSApplication.shared
        keychain = KeychainStore(service: testService)
        try keychain.deleteAllForService()
        fake = FakeHTTPClient()
        app = AppDelegate(services: makeServices(keychain: keychain, httpClient: fake))
        // S85: stub the revoke-failure alert so async sign-out doesn't hang
        // on NSAlert.runModal() inside headless xctest. /revoke fails fast
        // against the localhost:0 base URL — this seam just suppresses the UI.
        app.presentRevokeWarning = {}
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
        defer { cleanSettingsDefaults(for: id) }
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        wireFirstRunForTest(app, folder: folder)

        app.applyBearer(workspaceID: id, bearer: kBearerA)

        XCTAssertEqual(try keychain.retrieve(workspaceID: id), kBearerA)
        XCTAssertEqual(app.workspaces.count, 1)
        XCTAssertEqual(app.workspaces.first?.id, id)
        XCTAssertEqual(app.workspaces.first?.bearer, kBearerA)
    }

    func testHandleAuthURLOverwritesExistingWorkspace() throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        wireFirstRunForTest(app, folder: folder)

        // First call routes through presentFirstRun → confirmFirstRun → workspace appended.
        // Second call finds the workspace in `app.workspaces` and takes the upsert path.
        // BUG-2: stub confirmReauth before the second call so it doesn't block
        // on NSAlert, which hangs headless test runs.
        app.applyBearer(workspaceID: id, bearer: kBearerA)
        app.confirmReauth = { _ in true }
        app.applyBearer(workspaceID: id, bearer: kBearerB)

        XCTAssertEqual(app.workspaces.count, 1, "Same workspace ID should not duplicate")
        XCTAssertEqual(try keychain.retrieve(workspaceID: id), kBearerB)
        XCTAssertEqual(app.workspaces.first?.bearer, kBearerB)
    }

    // MARK: - applyBearer skipReauthConfirmation gate (Phase 3)

    /// In-app auth path: `skipReauthConfirmation: true` must rotate the bearer
    /// on an existing workspace WITHOUT calling `confirmReauth`.
    func testApplyBearerSkipReauthConfirmationBypassesGate() throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        wireFirstRunForTest(app, folder: folder)

        // Seed the workspace via the first-run path.
        app.applyBearer(workspaceID: id, bearer: kBearerA)

        // Replace confirmReauth with a trip-wire that fails the test if called.
        var reauthCalled = false
        app.confirmReauth = { _ in reauthCalled = true; return false }

        // In-app path: skipReauthConfirmation = true must bypass the gate.
        app.applyBearer(workspaceID: id, bearer: kBearerB, skipReauthConfirmation: true)

        XCTAssertFalse(reauthCalled, "confirmReauth must NOT be called on the trusted in-app path")
        XCTAssertEqual(try keychain.retrieve(workspaceID: id), kBearerB)
        XCTAssertEqual(app.workspaces.first?.bearer, kBearerB)
    }

    /// Deep-link path: default `skipReauthConfirmation: false` must still trigger
    /// `confirmReauth` for an existing workspace.
    func testApplyBearerDeepLinkPathTriggersConfirmReauth() throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        wireFirstRunForTest(app, folder: folder)

        app.applyBearer(workspaceID: id, bearer: kBearerA)

        var reauthCalled = false
        app.confirmReauth = { _ in reauthCalled = true; return true }

        // Deep-link path uses default (false) → gate must fire.
        app.applyBearer(workspaceID: id, bearer: kBearerB)

        XCTAssertTrue(reauthCalled, "confirmReauth MUST be called on the deep-link path")
        XCTAssertEqual(try keychain.retrieve(workspaceID: id), kBearerB)
    }

    /// When the user cancels the re-auth gate on the deep-link path, bearer
    /// must NOT be rotated.
    func testApplyBearerDeepLinkPathCancelledLeavesOriginalBearer() throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        wireFirstRunForTest(app, folder: folder)

        app.applyBearer(workspaceID: id, bearer: kBearerA)
        app.confirmReauth = { _ in false }  // user cancels

        app.applyBearer(workspaceID: id, bearer: kBearerB)

        XCTAssertEqual(try keychain.retrieve(workspaceID: id), kBearerA, "Original bearer must survive a cancelled re-auth")
        XCTAssertEqual(app.workspaces.first?.bearer, kBearerA)
    }

    func testHandleAuthURLIgnoresMalformedURL() throws {
        let badURL = URL(string: "https://example.com/foo")!
        app.handleAuthURL(badURL)

        XCTAssertTrue(app.workspaces.isEmpty)
        XCTAssertEqual(try keychain.retrieveAll().count, 0)
    }

    // MARK: - B1 code-exchange flow

    /// Happy path: PKCE seeded → handleAuthURL with code URL → fake HTTP
    /// returns 200 + bearer → applyBearer routes through firstRun, bearer
    /// lands in Keychain. Mirrors the production flow end-to-end with
    /// stubbed network.
    func testHandleAuthURLExchangeHappyPath() async throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        wireFirstRunForTest(app, folder: folder)

        // Seed PKCE the same way menuConnectAccount would.
        let (challenge, _) = app.pkceStore.beginSignin()
        XCTAssertEqual(challenge.count, 43)

        // Stub /signin/exchange response.
        let serverBearer = "exchanged-bearer" + String(repeating: "0", count: 16)
        let respBody = try JSONSerialization.data(withJSONObject: [
            "bearer": serverBearer,
            "workspace_id": id.uuidString,
            "expires_at": "2099-01-01T00:00:00.000Z",
        ])
        await fake.setStubbedResponse(.success(HTTPResponse(status: 200, body: respBody)))

        let exp = expectation(description: "exchange POST sent")
        await fake.setOnSend { exp.fulfill() }

        let code = String(repeating: "ab12cd34", count: 8)
        let url = URL(string: "taproot://auth?code=\(code)&workspace=\(id.uuidString)")!
        app.handleAuthURL(url)

        await fulfillment(of: [exp], timeout: 2.0)
        // Allow the post-exchange Task continuation to land on MainActor.
        try await Task.sleep(nanoseconds: 100_000_000)

        XCTAssertEqual(try keychain.retrieve(workspaceID: id), serverBearer)
        XCTAssertEqual(app.workspaces.count, 1)
        XCTAssertEqual(app.workspaces.first?.bearer, serverBearer)

        // Sent body should carry the verifier (consumed) — sanity check the request shape.
        let first = await fake.firstRequest
        XCTAssertEqual(first?.url.path, "/signin/exchange")
        XCTAssertEqual(first?.method, "POST")
    }

    /// Missing verifier (helper restarted between Connect click + deep-link
    /// callback) → presentSigninError fires, no exchange POST issued, no
    /// bearer stored.
    func testHandleAuthURLWithoutVerifierShowsAlert() async throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }

        var alertMessage: String?
        let alertExp = expectation(description: "alert presented")
        app.presentSigninError = { msg in
            alertMessage = msg
            alertExp.fulfill()
        }

        let code = String(repeating: "deadbeef", count: 8)
        let url = URL(string: "taproot://auth?code=\(code)&workspace=\(id.uuidString)")!
        app.handleAuthURL(url)

        await fulfillment(of: [alertExp], timeout: 1.0)
        XCTAssertTrue(alertMessage?.contains("Open the Taproot menu") == true)
        let count = await fake.sendCount
        XCTAssertEqual(count, 0, "no exchange POST should fire when verifier missing")
        XCTAssertEqual(try keychain.retrieveAll().count, 0)
    }

    /// Server returns 400 pkce_mismatch → presentSigninError fires with
    /// the verification-failed message; no bearer stored.
    func testHandleAuthURLExchangeServerErrorShowsAlert() async throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }

        app.pkceStore.beginSignin()

        let respBody = try JSONSerialization.data(withJSONObject: [
            "error": "pkce_mismatch",
        ])
        await fake.setStubbedResponse(.success(HTTPResponse(status: 400, body: respBody)))

        var alertMessage: String?
        let alertExp = expectation(description: "alert presented")
        app.presentSigninError = { msg in
            alertMessage = msg
            alertExp.fulfill()
        }

        let code = String(repeating: "ab12cd34", count: 8)
        let url = URL(string: "taproot://auth?code=\(code)&workspace=\(id.uuidString)")!
        app.handleAuthURL(url)

        await fulfillment(of: [alertExp], timeout: 2.0)
        XCTAssertTrue(alertMessage?.contains("verification failed") == true,
                      "got: \(alertMessage ?? "nil")")
        XCTAssertEqual(try keychain.retrieveAll().count, 0)
    }

    /// Server echoes a different workspace_id than the deep-link
    /// (defense-in-depth) → presentSigninError fires; nothing stored.
    func testHandleAuthURLExchangeWorkspaceMismatchAlerts() async throws {
        let deeplinkID = UUID()
        let serverID = UUID()
        defer { cleanSettingsDefaults(for: deeplinkID) }

        app.pkceStore.beginSignin()

        let respBody = try JSONSerialization.data(withJSONObject: [
            "bearer": String(repeating: "a", count: 64),
            "workspace_id": serverID.uuidString,
            "expires_at": "2099-01-01T00:00:00.000Z",
        ])
        await fake.setStubbedResponse(.success(HTTPResponse(status: 200, body: respBody)))

        var alertMessage: String?
        let alertExp = expectation(description: "alert presented")
        app.presentSigninError = { msg in
            alertMessage = msg
            alertExp.fulfill()
        }

        let code = String(repeating: "ab12cd34", count: 8)
        let url = URL(string: "taproot://auth?code=\(code)&workspace=\(deeplinkID.uuidString)")!
        app.handleAuthURL(url)

        await fulfillment(of: [alertExp], timeout: 2.0)
        XCTAssertTrue(alertMessage?.contains("workspace mismatch") == true,
                      "got: \(alertMessage ?? "nil")")
        XCTAssertEqual(try keychain.retrieveAll().count, 0)
    }

    func testSignOutClearsKeychainAndRemovesWorkspace() async throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        wireFirstRunForTest(app, folder: folder)
        app.applyBearer(workspaceID: id, bearer: kBearerToClear)
        XCTAssertEqual(app.workspaces.count, 1)

        await app.signOut(workspaceID: id)

        XCTAssertNil(try keychain.retrieve(workspaceID: id))
        XCTAssertTrue(app.workspaces.isEmpty)
    }

    func testSignOutOnlyAffectsTargetWorkspace() async throws {
        let id1 = UUID()
        let id2 = UUID()
        defer { cleanSettingsDefaults(for: id1) }
        defer { cleanSettingsDefaults(for: id2) }
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        wireFirstRunForTest(app, folder: folder)
        app.applyBearer(workspaceID: id1, bearer: kBearerKeep)
        app.applyBearer(workspaceID: id2, bearer: kBearerRemove)

        await app.signOut(workspaceID: id2)

        XCTAssertEqual(app.workspaces.count, 1)
        XCTAssertEqual(app.workspaces.first?.id, id1)
        XCTAssertEqual(try keychain.retrieve(workspaceID: id1), kBearerKeep)
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

    func testSignOutStopsAndRemovesWatcher() async throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        wireFirstRunForTest(app, folder: folder)
        app.applyBearer(workspaceID: id, bearer: kBearerWatchMe)
        // confirmFirstRun already started a watcher; startAllWatchers is a no-op
        // for IDs already in the dict (idempotent guard).
        app.startAllWatchers()
        XCTAssertNotNil(app.watchers[id])

        await app.signOut(workspaceID: id)

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
        UserDefaults.standard.removeObject(forKey: "taproot.workspaceName.\(id.uuidString)")
        UserDefaults.standard.removeObject(forKey: "taproot.vaultFolder.\(id.uuidString)")
    }

    /// T11.7 fixup: routes the new-workspace branch of handleAuthURL through
    /// confirmFirstRun synchronously so tests that pre-T11.7 assumed direct
    /// mutation keep working. Stops the poller right after confirm so the
    /// 100ms-delayed initial pull tick doesn't race the test's own HTTP
    /// expectations. Retargeted in T11.8 commit 2 to the extracted
    /// `firstRun` Coordinator seam.
    private func wireFirstRunForTest(_ app: AppDelegate, folder: URL) {
        // Phase 1 (0.1.5): keep the synchronous test-mode path so existing
        // tests that assert workspace state immediately after applyBearer
        // keep working. Tests that exercise the InitialSyncCoordinator path
        // explicitly leave skipInitialSyncForTesting at its default (false).
        app.skipInitialSyncForTesting = true
        app.firstRun.presentFirstRun = { id, bearer in
            app.confirmFirstRun(workspaceID: id, bearer: bearer, name: "Workspace", vaultFolder: folder)
            app.stopPullPoller(for: id)
        }
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
        testApp.presentRevokeWarning = {}
        await testApp.signOut(workspaceID: id)

        XCTAssertNil(testApp.pullPollers[id], "signOut must remove poller from dict")
        XCTAssertNil(testApp.pullCursors[id], "signOut must clear in-memory cursor")
        XCTAssertNil(UserDefaults.standard.string(forKey: "taproot.lastSync.\(id.uuidString)"))
        XCTAssertNil(UserDefaults.standard.string(forKey: "taproot.lastSyncId.\(id.uuidString)"))

        // Give any in-flight tick a generous beat to finish + verify no NEW
        // sends fire after sign-out.
        try await Task.sleep(nanoseconds: 500_000_000)
        let sendsAfter = await localFake.sendCount
        // Blocker 1 — pullTick now fires 2 HTTP sends per tick once the cursor
        // is seeded (pre-tick pending-count + pull). Allow up to 2 sends from
        // a single in-flight tick that started before signOut cancelled the
        // poller.
        XCTAssertLessThanOrEqual(
            sendsAfter,
            sendsBeforeSignOut + 2,
            "no new pull sends after signOut (allow 1 in-flight tick = up to 2 sends: pending-count + pull)"
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
        defer { cleanSettingsDefaults(for: id) }
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
        testApp.presentRevokeWarning = {}
        await testApp.syncEngine.setOnUnauthorized { [weak testApp] id in
            Task { @MainActor [weak testApp] in
                await testApp?.signOut(workspaceID: id)
            }
        }

        // T11.7 fixup: route handleAuthURL's new-workspace branch through
        // confirmFirstRun pointing at this test's actual file-write folder
        // (no need to override workspaces[0].localFolder afterwards).
        wireFirstRunForTest(testApp, folder: folder)

        // Seed workspace + Keychain + watcher.
        testApp.applyBearer(workspaceID: id, bearer: kBearerInFlight)
        XCTAssertEqual(testApp.workspaces.count, 1)
        testApp.startAllWatchers()
        XCTAssertNotNil(testApp.watchers[id])

        // Synchronize on the HTTP send so we know the push entered the engine.
        let sendExp = expectation(description: "push hits server")
        await localFake.setOnSend { sendExp.fulfill() }

        // Write at the workspace's canonical localFolder (not the original
        // `folder` URL). confirmFirstRun canonicalizes via realpath, so
        // /var/folders/... becomes /private/var/folders/... — toOp's prefix
        // check would otherwise reject the event path.
        let canonicalFolder = testApp.workspaces[0].localFolder
        let filePath = canonicalFolder.appendingPathComponent("note.md")
        try Data("x".utf8).write(to: filePath)

        // Kick the push (engine will receive 401 → fire onUnauthorized → call
        // signOut on MainActor a beat later).
        testApp.handleFileChanges(
            workspaceID: id,
            events: [FileChangeEvent(path: filePath, kind: .created, mtime: nil)]
        )

        // Direct user-driven sign-out (now async — awaits /revoke with 3s timeout).
        // The 401 callback is queued on MainActor and runs after this returns;
        // it must be idempotent.
        await testApp.signOut(workspaceID: id)
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

    func testPerformSignOutMatchesSignOutBehavior() async throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        wireFirstRunForTest(app, folder: folder)
        app.applyBearer(workspaceID: id, bearer: kBearerToClear)
        XCTAssertEqual(app.workspaces.count, 1)

        await app.performSignOut(workspaceID: id)

        XCTAssertNil(try keychain.retrieve(workspaceID: id))
        XCTAssertTrue(app.workspaces.isEmpty)
    }

    func testMenuSignOutSkipsWhenConfirmDeclined() throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        wireFirstRunForTest(app, folder: folder)
        app.applyBearer(workspaceID: id, bearer: kBearerKeep)
        XCTAssertEqual(app.workspaces.count, 1)

        app.confirmSignOut = { _ in false }

        let item = NSMenuItem(title: "Sign out", action: nil, keyEquivalent: "")
        item.representedObject = id
        app.menuSignOut(item)

        XCTAssertEqual(app.workspaces.count, 1, "Cancelled confirm leaves workspace in place")
        XCTAssertEqual(try keychain.retrieve(workspaceID: id), kBearerKeep)
    }

    func testMenuSignOutInvokesPerformWhenConfirmed() async throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        wireFirstRunForTest(app, folder: folder)
        app.applyBearer(workspaceID: id, bearer: kBearerRemove)
        XCTAssertEqual(app.workspaces.count, 1)

        app.confirmSignOut = { _ in true }

        let item = NSMenuItem(title: "Sign out", action: nil, keyEquivalent: "")
        item.representedObject = id
        app.menuSignOut(item)
        // S85: menuSignOut wraps performSignOut in Task { @MainActor in await ... }
        // so the spawned work must drain before assertions run.
        await drainMainActor()

        XCTAssertTrue(app.workspaces.isEmpty)
        XCTAssertNil(try keychain.retrieve(workspaceID: id))
    }

    /// Drains queued MainActor work spawned by sync action handlers (e.g.
    /// `menuSignOut` -> `Task { @MainActor in await performSignOut }`). Polls
    /// briefly so async sign-out can complete; bails after ~3s if not idle.
    private func drainMainActor(maxAttempts: Int = 30) async {
        for _ in 0..<maxAttempts {
            try? await Task.sleep(nanoseconds: 100_000_000)
            await Task.yield()
            if app.workspaces.isEmpty { return }
        }
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

        // Flat layout: name, status, sep, Open vault folder, Open in Obsidian, Pause/Resume, Settings…, Sign out, sep, Check for updates…, Quit.
        XCTAssertEqual(menu.items[5].title, "Resume sync")
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

        // Error state is surfaced in the status line at items[1] (no lastSyncAt → "Error · Never synced").
        // The old "Last error: transport" item is replaced by the status line.
        let statusItem = menu.items[1]
        XCTAssertEqual(statusItem.title, "Error · Never synced")
        XCTAssertFalse(statusItem.isEnabled)
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

    func testSignOutClearsPausedOnLaunchKey() async throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        wireFirstRunForTest(app, folder: folder)
        app.applyBearer(workspaceID: id, bearer: kBearerClearMe)

        app.togglePauseSync(workspaceID: id)
        XCTAssertTrue(UserDefaults.standard.bool(forKey: "taproot.pausedOnLaunch.\(id.uuidString)"))

        await app.signOut(workspaceID: id)

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

        // Shape: [name (disabled), Synced (status, disabled), separator,
        //         Open vault folder, Open in Obsidian, Pause sync,
        //         Settings…, Sign out, separator, Check for updates…, Quit] = 11 items.
        XCTAssertEqual(menu.items.count, 11)

        XCTAssertEqual(menu.items[0].title, "WS")
        XCTAssertFalse(menu.items[0].isEnabled, "Workspace name row is a disabled label")

        // Status line: "Synced" (no lastSyncAt, so no timestamp)
        XCTAssertEqual(menu.items[1].title, "Synced")
        XCTAssertFalse(menu.items[1].isEnabled, "Status row is disabled")
        XCTAssertTrue(menu.items[2].isSeparatorItem)

        let openFolder = menu.items[3]
        XCTAssertEqual(openFolder.title, "Open vault folder")
        XCTAssertEqual(openFolder.representedObject as? UUID, id)

        let openInObsidian = menu.items[4]
        XCTAssertEqual(openInObsidian.title, "Open in Obsidian")
        XCTAssertEqual(openInObsidian.representedObject as? UUID, id)
        XCTAssertEqual(openInObsidian.action, #selector(AppDelegate.menuOpenInObsidian(_:)))

        let pauseSync = menu.items[5]
        XCTAssertEqual(pauseSync.title, "Pause sync")
        XCTAssertEqual(pauseSync.representedObject as? UUID, id)

        let settings = menu.items[6]
        XCTAssertEqual(settings.title, "Settings…")
        XCTAssertTrue(settings.isEnabled, "Settings… enabled in T11.6")
        XCTAssertEqual(settings.action, #selector(AppDelegate.menuOpenSettings(_:)))

        let signOut = menu.items[7]
        XCTAssertEqual(signOut.title, "Sign out")
        XCTAssertEqual(signOut.representedObject as? UUID, id)

        XCTAssertTrue(menu.items[8].isSeparatorItem)

        XCTAssertEqual(menu.items[9].title, "Check for updates…")
        XCTAssertEqual(menu.items[10].title, "Quit")
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

        // Nested shape: [ws1 > submenu, ws2 > submenu, separator, Check for updates…, Quit] = 5 items.
        XCTAssertEqual(menu.items.count, 5)

        XCTAssertEqual(menu.items[0].title, "Alpha")
        let alphaSubmenu = try XCTUnwrap(menu.items[0].submenu)
        XCTAssertEqual(menu.items[1].title, "Beta")
        let betaSubmenu = try XCTUnwrap(menu.items[1].submenu)

        XCTAssertTrue(menu.items[2].isSeparatorItem)
        XCTAssertEqual(menu.items[3].title, "Check for updates…")
        XCTAssertEqual(menu.items[4].title, "Quit")

        // Each submenu: status (disabled), separator, then 5 per-workspace actions = 7 items.
        // No name-label (the top-level row already labels which workspace).
        XCTAssertEqual(alphaSubmenu.items.count, 7)
        XCTAssertEqual(alphaSubmenu.items[0].title, "Synced")
        XCTAssertFalse(alphaSubmenu.items[0].isEnabled)
        XCTAssertTrue(alphaSubmenu.items[1].isSeparatorItem)
        XCTAssertEqual(alphaSubmenu.items[2].title, "Open vault folder")
        XCTAssertEqual(alphaSubmenu.items[2].representedObject as? UUID, id1)
        XCTAssertEqual(alphaSubmenu.items[3].title, "Open in Obsidian")
        XCTAssertEqual(alphaSubmenu.items[3].representedObject as? UUID, id1)
        XCTAssertEqual(alphaSubmenu.items[4].title, "Pause sync")
        XCTAssertEqual(alphaSubmenu.items[4].representedObject as? UUID, id1)
        XCTAssertEqual(alphaSubmenu.items[5].title, "Settings…")
        XCTAssertTrue(alphaSubmenu.items[5].isEnabled)
        XCTAssertEqual(alphaSubmenu.items[6].title, "Sign out")
        XCTAssertEqual(alphaSubmenu.items[6].representedObject as? UUID, id1)

        // Beta submenu action items are pinned to ws2.id.
        XCTAssertEqual(betaSubmenu.items[2].representedObject as? UUID, id2)
        XCTAssertEqual(betaSubmenu.items[6].representedObject as? UUID, id2)
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

        // Blocker 1 — error strings rewritten for end-user clarity.
        // No lastSyncAt on this workspace → no timestamp suffix.
        XCTAssertEqual(testApp.workspaces[0].syncStatus, .error("Can't reach Taproot"))
    }

    func testRebuildMenuFiresOnSignOut() async throws {
        let id1 = UUID()
        let id2 = UUID()
        defer { cleanSettingsDefaults(for: id1) }
        defer { cleanSettingsDefaults(for: id2) }
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        wireFirstRunForTest(app, folder: folder)
        app.applyBearer(workspaceID: id1, bearer: kBearerAlpha)
        app.applyBearer(workspaceID: id2, bearer: kBearerBravo)
        XCTAssertEqual(app.currentMenu?.items.count, 5, "Pre-signOut: nested 5-item menu")

        await app.signOut(workspaceID: id2)

        // After sign-out the count drops to 1 → flat 11-item shape (name, status, sep, 5 actions, sep, updates, quit).
        let after = try XCTUnwrap(app.currentMenu)
        XCTAssertEqual(after.items.count, 11)
    }

    func testRebuildMenuFiresOnHandleAuthURL() throws {
        let id1 = UUID()
        let id2 = UUID()
        defer { cleanSettingsDefaults(for: id1) }
        defer { cleanSettingsDefaults(for: id2) }
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        wireFirstRunForTest(app, folder: folder)
        app.applyBearer(workspaceID: id1, bearer: kBearerAlpha)

        // After 1 workspace, currentMenu reflects the 11-item flat shape (name, status, sep, 5 actions, sep, updates, quit).
        let afterFirst = try XCTUnwrap(app.currentMenu)
        XCTAssertEqual(afterFirst.items.count, 11, "Flat layout after first auth")

        app.applyBearer(workspaceID: id2, bearer: kBearerBravo)
        app.confirmReauth = { _ in true }

        // After 2 workspaces, currentMenu reflects the 5-item nested shape.
        let afterSecond = try XCTUnwrap(app.currentMenu)
        XCTAssertEqual(afterSecond.items.count, 5, "Nested layout after second auth")
        XCTAssertNotNil(afterSecond.items[0].submenu)
        XCTAssertNotNil(afterSecond.items[1].submenu)
        XCTAssertTrue(afterSecond.items[2].isSeparatorItem)
        XCTAssertEqual(afterSecond.items[3].title, "Check for updates…")
        XCTAssertEqual(afterSecond.items[4].title, "Quit")
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

    func testSettingsCheckForUpdatesProxiesToUpdates() {
        // Drive the wired presentSettings path: applicationDidFinishLaunching
        // is what assigns the production presentSettings closure that wires
        // the SettingsWindowController with onCheckForUpdates → updates.checkForUpdates.
        // Stub the rest of the lifecycle so it stays atomic.
        let fake = FakeUpdaterService()
        app.makeUpdaterService = { fake }
        app.firstRun.presentFirstRun = { _, _ in }
        app.applicationDidFinishLaunching(Notification(name: .init("test")))

        // Open the Settings window and click the Check-for-updates button.
        // SettingsWindowController exposes the button's selector as
        // `checkUpdatesClicked`; we drive it via the wired callback chain
        // by performing the button's action against its target.
        app.presentSettings()
        let updatesButton = findButton(
            in: app.settingsWindowController?.window?.contentView,
            titled: "Check for updates…"
        )
        XCTAssertNotNil(updatesButton, "Settings window must surface a Check-for-updates button")

        if let button = updatesButton, let action = button.action, let target = button.target as? NSObject {
            target.perform(action, with: button)
        }

        XCTAssertEqual(fake.checkForUpdatesCallCount, 1,
                       "Settings → Check-for-updates must proxy to updates.checkForUpdates()")
    }

    /// Recursive search for a button by title across NSStackView / NSGridView
    /// hierarchies. Used by testSettingsCheckForUpdatesProxiesToUpdates.
    private func findButton(in view: NSView?, titled title: String) -> NSButton? {
        guard let view else { return nil }
        if let button = view as? NSButton, button.title == title { return button }
        for sub in view.subviews {
            if let hit = findButton(in: sub, titled: title) { return hit }
        }
        return nil
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

    // MARK: - T11.7 read-side wiring (commit 3)

    func testLoadWorkspacesFromKeychainReadsNameFromSettingsStore() throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        try keychain.store(workspaceID: id, bearer: "x")
        UserDefaults.standard.set("My Vault", forKey: "taproot.workspaceName.\(id.uuidString)")

        let freshApp = AppDelegate(services: makeServices(keychain: keychain))
        freshApp.loadWorkspacesFromKeychain()

        XCTAssertEqual(freshApp.workspaces.first?.name, "My Vault")
    }

    func testLoadWorkspacesFromKeychainFallsBackToWorkspaceWhenNameMissing() throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        try keychain.store(workspaceID: id, bearer: "x")

        let freshApp = AppDelegate(services: makeServices(keychain: keychain))
        freshApp.loadWorkspacesFromKeychain()

        XCTAssertEqual(freshApp.workspaces.first?.name, "Workspace")
    }

    func testLoadWorkspacesFromKeychainReadsFolderFromSettingsStore() throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        try keychain.store(workspaceID: id, bearer: "x")
        let folder = URL(fileURLWithPath: "/tmp/xyz")
        // N10: SettingsStore.setVaultFolder stores `url.path`; pre-seed the
        // raw filesystem path the same way so vaultFolder's
        // URL(fileURLWithPath:) read round-trips correctly.
        UserDefaults.standard.set(
            folder.path,
            forKey: "taproot.vaultFolder.\(id.uuidString)"
        )

        let freshApp = AppDelegate(services: makeServices(keychain: keychain))
        freshApp.loadWorkspacesFromKeychain()

        // canonicalPath resolves /tmp -> /private/tmp via realpath() on macOS.
        XCTAssertEqual(
            freshApp.workspaces.first?.localFolder.path,
            folder.canonicalPath.path
        )
    }

    func testLoadWorkspacesFromKeychainFallsBackToDefaultFolderWhenNotPersisted() throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        try keychain.store(workspaceID: id, bearer: "x")

        let freshApp = AppDelegate(services: makeServices(keychain: keychain))
        freshApp.loadWorkspacesFromKeychain()

        guard let path = freshApp.workspaces.first?.localFolder.path else {
            XCTFail("expected loaded workspace")
            return
        }
        XCTAssertTrue(
            path.hasSuffix("Taproot/\(id.uuidString)"),
            "expected default folder suffix, got \(path)"
        )
    }

    func testSignOutClearsWorkspaceNameKey() async throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        try keychain.store(workspaceID: id, bearer: "x")
        app.settingsStore.setWorkspaceName("X", for: id)
        XCTAssertNotNil(UserDefaults.standard.string(forKey: "taproot.workspaceName.\(id.uuidString)"))

        await app.signOut(workspaceID: id)

        XCTAssertNil(
            UserDefaults.standard.object(forKey: "taproot.workspaceName.\(id.uuidString)"),
            "Sign-out must clear workspace name so reconnect starts clean"
        )
    }

    func testSignOutClearsVaultFolderKey() async throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        try keychain.store(workspaceID: id, bearer: "x")
        app.settingsStore.setVaultFolder(URL(fileURLWithPath: "/tmp/x"), for: id)
        XCTAssertNotNil(UserDefaults.standard.string(forKey: "taproot.vaultFolder.\(id.uuidString)"))

        await app.signOut(workspaceID: id)

        XCTAssertNil(
            UserDefaults.standard.object(forKey: "taproot.vaultFolder.\(id.uuidString)"),
            "Sign-out must clear vault folder so reconnect starts clean"
        )
    }

    // MARK: - T11.7 first-run routing (commit 4)

    func testHandleAuthURLForNewWorkspaceCallsPresentFirstRunSeam() throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        var capturedID: UUID?
        var capturedBearer: String?
        let exp = expectation(description: "presentFirstRun fired")
        app.firstRun.presentFirstRun = { id, bearer in
            capturedID = id
            capturedBearer = bearer
            exp.fulfill()
        }

        app.applyBearer(workspaceID: id, bearer: kBearerBig)

        wait(for: [exp], timeout: 1.0)
        XCTAssertEqual(capturedID, id)
        XCTAssertEqual(capturedBearer, kBearerBig)
        XCTAssertEqual(try keychain.retrieve(workspaceID: id), kBearerBig,
                       "Bearer must land in Keychain immediately on first-connect")
        XCTAssertTrue(
            app.workspaces.isEmpty,
            "Workspace must NOT be appended until confirmFirstRun runs"
        )
    }

    func testHandleAuthURLForExistingWorkspaceUpdatesBearerWithoutFirstRun() throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        // Pre-seed an existing workspace so handleAuthURL takes the upsert path.
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        app.workspaces = [
            Workspace(
                id: id,
                name: "Existing",
                bearer: "old",
                localFolder: folder,
                lastSyncAt: nil,
                syncStatus: .idle
            )
        ]
        app.firstRun.presentFirstRun = { _, _ in
            XCTFail("Re-auth must NOT show the welcome window")
        }
        // /security-audit C3 (2026-04-30): re-auth gate confirms user
        // intent before bearer rotation. Stub returns true to keep this
        // test asserting the rotation behaviour.
        app.confirmReauth = { _ in true }

        app.applyBearer(workspaceID: id, bearer: kBearerNew)

        XCTAssertEqual(app.workspaces.count, 1)
        XCTAssertEqual(app.workspaces[0].bearer, kBearerNew)
        XCTAssertEqual(try keychain.retrieve(workspaceID: id), kBearerNew)
    }

    /// /security-audit C3 (2026-04-30): re-auth on an existing workspace must
    /// invoke the confirmation gate with the current Workspace before any
    /// Keychain write or in-memory bearer rotation. Closes the
    /// `taproot://auth?bearer=<attacker>&workspace=<victim-uuid>` exfiltration
    /// path documented in [[daily/2026-04-30-taproot-security-audit]] §C3.
    func testHandleAuthURLAsksConfirmReauthOnExistingWorkspaceMatch() throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        try keychain.store(workspaceID: id, bearer: "old")
        app.workspaces = [
            Workspace(
                id: id,
                name: "MyVault",
                bearer: "old",
                localFolder: folder,
                lastSyncAt: nil,
                syncStatus: .idle
            )
        ]
        app.firstRun.presentFirstRun = { _, _ in
            XCTFail("Re-auth must NOT show the welcome window")
        }
        var capturedWorkspace: Workspace?
        app.confirmReauth = { ws in
            capturedWorkspace = ws
            return true
        }

        app.applyBearer(workspaceID: id, bearer: kBearerNew)

        XCTAssertEqual(capturedWorkspace?.id, id, "confirmReauth must receive the existing Workspace")
        XCTAssertEqual(capturedWorkspace?.name, "MyVault")
        XCTAssertEqual(capturedWorkspace?.bearer, "old", "confirmReauth must see the OLD bearer (rotation hasn't happened yet)")
        XCTAssertEqual(app.workspaces[0].bearer, kBearerNew)
        XCTAssertEqual(try keychain.retrieve(workspaceID: id), kBearerNew)
    }

    /// /security-audit C3 (2026-04-30): if the user cancels the re-auth
    /// alert, neither the Keychain bearer nor the in-memory workspace
    /// bearer must change. Confirms the attacker-driven `taproot://` URL
    /// is fully neutralized when the user declines.
    func testHandleAuthURLCancelReauthLeavesKeychainAndStateUnchanged() throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        try keychain.store(workspaceID: id, bearer: "legit-bearer")
        app.workspaces = [
            Workspace(
                id: id,
                name: "MyVault",
                bearer: "legit-bearer",
                localFolder: folder,
                lastSyncAt: nil,
                syncStatus: .idle
            )
        ]
        app.firstRun.presentFirstRun = { _, _ in
            XCTFail("Re-auth must NOT show the welcome window")
        }
        app.confirmReauth = { _ in false }

        app.applyBearer(workspaceID: id, bearer: kBearerAttacker)

        XCTAssertEqual(app.workspaces[0].bearer, "legit-bearer", "Cancel must not rotate in-memory bearer")
        XCTAssertEqual(try keychain.retrieve(workspaceID: id), "legit-bearer", "Cancel must not write attacker bearer to Keychain")
    }

    func testConfirmFirstRunPersistsAndStartsWatcherPlusPoller() throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }

        // Phase 1 (0.1.5): existing assertion shape requires the synchronous
        // test path. The InitialSyncCoordinator-aware test lives in
        // InitialSyncCoordinatorTests.
        app.skipInitialSyncForTesting = true
        app.confirmFirstRun(workspaceID: id, bearer: "B", name: "MyVault", vaultFolder: folder)
        defer {
            app.watchers[id]?.stop()
            app.stopPullPoller(for: id)
        }

        XCTAssertEqual(app.settingsStore.workspaceName(for: id), "MyVault")
        // N10: compare paths rather than absoluteStrings — for an existing
        // directory, URL(fileURLWithPath:) appends a trailing slash that the
        // input URL (built via appendingPathComponent) doesn't have. Path
        // comparison is the canonical filesystem-identity check.
        XCTAssertEqual(app.settingsStore.vaultFolder(for: id)?.path,
                       folder.path)
        XCTAssertEqual(app.workspaces.count, 1)
        XCTAssertEqual(app.workspaces.first?.name, "MyVault")
        XCTAssertEqual(app.workspaces.first?.localFolder.path, folder.canonicalPath.path)
        XCTAssertEqual(app.workspaces.first?.bearer, "B")
        XCTAssertNotNil(app.watchers[id], "Watcher must start on confirmFirstRun")
        XCTAssertNotNil(app.pullPollers[id], "Poller must start on confirmFirstRun")
    }

    /// 0.1.10: confirmFirstRun must pre-create the 5 starter folders on the
    /// vault root so the server-rendered CLAUDE.md filing tree references
    /// match disk reality from t=0. Thin wiring assertion — full helper
    /// behavior is covered in StarterFoldersTests.
    func testConfirmFirstRunPreCreatesStarterFolders() throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }

        app.skipInitialSyncForTesting = true
        app.confirmFirstRun(workspaceID: id, bearer: "B", name: "MyVault", vaultFolder: folder)
        defer {
            app.watchers[id]?.stop()
            app.stopPullPoller(for: id)
        }

        for name in StarterFolders.names {
            let url = folder.canonicalPath.appendingPathComponent(name, isDirectory: true)
            var isDir: ObjCBool = false
            let exists = FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir)
            XCTAssertTrue(exists && isDir.boolValue,
                          "Starter folder \(name)/ must exist on disk after confirmFirstRun")
        }
    }

    /// C1 (build-audit-3): rapid double-fire of confirmFirstRun (e.g. a user
    /// double-clicking "Get started" before the window dismisses, or two
    /// presentFirstRun Tasks racing through fetchWorkspaceName) must not
    /// append the same workspace twice. Other mutation paths (handleAuthURL
    /// re-auth) already use `firstIndex(where:)` to dedup; confirmFirstRun
    /// must mirror that guard.
    func testConfirmFirstRunDedupsOnDoubleConfirm() throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }

        app.skipInitialSyncForTesting = true
        app.confirmFirstRun(workspaceID: id, bearer: "B", name: "MyVault", vaultFolder: folder)
        app.confirmFirstRun(workspaceID: id, bearer: "B", name: "MyVault", vaultFolder: folder)
        defer {
            app.watchers[id]?.stop()
            app.stopPullPoller(for: id)
        }

        XCTAssertEqual(app.workspaces.count, 1,
                       "Double-confirm must not append the same workspace twice")
        XCTAssertEqual(app.workspaces.filter { $0.id == id }.count, 1)
    }

    func testCancelFirstRunDeletesBearerAndClearsState() throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        try keychain.store(workspaceID: id, bearer: "B")
        app.settingsStore.setWorkspaceName("X", for: id)
        app.settingsStore.setVaultFolder(URL(fileURLWithPath: "/tmp/x"), for: id)

        app.cancelFirstRun(workspaceID: id)

        XCTAssertNil(try keychain.retrieve(workspaceID: id))
        XCTAssertNil(app.settingsStore.workspaceName(for: id))
        XCTAssertNil(app.settingsStore.vaultFolder(for: id))
        XCTAssertTrue(app.workspaces.isEmpty,
                      "Workspace was never appended, no removal needed")
    }

    func testHandleAuthURLDoesNotStartWatcherOrPollerOnFirstConnect() throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        // No-op seam: skip the welcome-window flow entirely.
        app.firstRun.presentFirstRun = { _, _ in }

        app.applyBearer(workspaceID: id, bearer: kBearerBig)

        XCTAssertTrue(app.watchers.isEmpty,
                      "Watcher must not start before confirmFirstRun")
        XCTAssertTrue(app.pullPollers.isEmpty,
                      "Poller must not start before confirmFirstRun")
    }

    // T11.7 fetchWorkspaceName + presentFirstRun wiring tests moved to
    // FirstRunCoordinatorTests in T11.8 commit 2 (the seams now live on
    // the extracted Coordinator). AppDelegate-level routing tests
    // (handleAuthURL → firstRun.presentFirstRun, menuConnectAccount →
    // firstRun.openConnectURL) stay below.

    // MARK: - T11.8 commit 4 (UpdateCoordinator ownership)

    func testMakeUpdaterServiceFactoryInjectsForUpdates() {
        let fake = FakeUpdaterService()
        app.makeUpdaterService = { fake }

        // Triggers the lazy `updates` initializer; the factory hands back
        // the fake, so subsequent calls drive `fake`.
        app.updates.start()

        XCTAssertEqual(fake.startCallCount, 1,
                       "AppDelegate's makeUpdaterService factory must inject into updates")
    }

    func testApplicationDidFinishLaunchingStartsUpdates() {
        let fake = FakeUpdaterService()
        app.makeUpdaterService = { fake }
        // Stub presentSettings + first-run no-op so the lifecycle doesn't
        // touch real UI surfaces beyond what xctest tolerates.
        app.firstRun.presentFirstRun = { _, _ in }

        app.applicationDidFinishLaunching(Notification(name: .init("test")))

        XCTAssertEqual(fake.startCallCount, 1,
                       "applicationDidFinishLaunching must call updates.start() exactly once")
        XCTAssertTrue(fake.isStarted)
    }

    func testConnectAccountMenuItemAppearsWhenWorkspacesEmpty() {
        let menu = app.buildMenu(for: [])

        // Phase 3 empty shape:
        // [Sign in to Taproot…, Pair with code…, separator,
        //  Connect via browser…, separator, Check for updates…, Quit] = 7 items.
        XCTAssertEqual(menu.items.count, 7, "Empty menu shape")

        let signIn = menu.items[0]
        XCTAssertEqual(signIn.title, "Sign in to Taproot…")
        XCTAssertTrue(signIn.isEnabled)
        XCTAssertEqual(signIn.action, #selector(AppDelegate.menuSignIn(_:)))

        let pair = menu.items[1]
        XCTAssertEqual(pair.title, "Pair with code…")
        XCTAssertEqual(pair.action, #selector(AppDelegate.menuEnterPairCode(_:)))

        XCTAssertTrue(menu.items[2].isSeparatorItem)

        let connectBrowser = menu.items[3]
        XCTAssertEqual(connectBrowser.title, "Connect via browser…")
        XCTAssertEqual(connectBrowser.action, #selector(AppDelegate.menuConnectAccount(_:)))

        XCTAssertTrue(menu.items[4].isSeparatorItem)

        XCTAssertEqual(menu.items[5].title, "Check for updates…")
        XCTAssertEqual(menu.items[6].title, "Quit")
    }

    func testMenuConnectAccountOpensSignInURL() async {
        var capturedURL: URL?
        let exp = expectation(description: "openConnectURL fired")
        app.firstRun.openConnectURL = { url in
            capturedURL = url
            exp.fulfill()
        }

        app.menuConnectAccount(NSMenuItem())
        await fulfillment(of: [exp], timeout: 1.0)

        // B1: URL now carries source + PKCE challenge + method. Assert each
        // expected query item rather than full string match (challenge is
        // randomized per-call).
        guard let url = capturedURL else {
            return XCTFail("captured URL must be non-nil")
        }
        XCTAssertEqual(url.path, "/signin")
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(items.first(where: { $0.name == "source" })?.value, "helper")
        XCTAssertEqual(items.first(where: { $0.name == "code_challenge_method" })?.value, "S256")
        let challenge = items.first(where: { $0.name == "code_challenge" })?.value ?? ""
        XCTAssertEqual(challenge.count, 43, "expected 43-char base64url challenge")
        // Verifier must have been seeded into the PKCEStore by beginSignin.
        XCTAssertNotNil(app.pkceStore.consumeVerifier(), "menuConnectAccount must seed PKCE verifier")
    }

    // MARK: - build-audit C1 (diagnosticSnapshot format)

    func testDiagnosticSnapshotFormat() {
        // Wire diagnosticSnapshot the same way AppDelegate does in
        // applicationDidFinishLaunching, but using syncEngine directly so
        // we don't need to call the full launch lifecycle.
        let syncEngine = app.syncEngine
        app.updates.diagnosticSnapshot = { [weak app, syncEngine] in
            let pif = syncEngine.pushInFlight
            let frw = app?.firstRun.isFirstRunWindowOpen ?? false
            return "isBusy=\(pif > 0 || frw); pushInFlight=\(pif); firstRunWindowOpen=\(frw)"
        }

        let snapshot = app.updates.diagnosticSnapshot()

        // build-audit C1: format must be parseable by monitoring tooling.
        // Pattern: isBusy=(true|false); pushInFlight=\d+; firstRunWindowOpen=(true|false)
        let pattern = #"^isBusy=(true|false); pushInFlight=\d+; firstRunWindowOpen=(true|false)$"#
        let matches = snapshot.range(of: pattern, options: .regularExpression) != nil
        XCTAssertTrue(
            matches,
            "diagnosticSnapshot format must match '\(pattern)', got: '\(snapshot)'"
        )
    }

    // MARK: - syncStatusText (Blocker 1: between-tick "X files behind")

    private func makeWorkspace(
        syncStatus: SyncStatus = .idle,
        pendingCount: Int? = nil,
        lastSyncAt: Date? = nil
    ) -> Workspace {
        Workspace(
            id: UUID(),
            name: "test",
            bearer: kBearerA,
            localFolder: FileManager.default.temporaryDirectory,
            lastSyncAt: lastSyncAt,
            pendingCount: pendingCount,
            syncStatus: syncStatus
        )
    }

    func testSyncStatusTextIdleWithNoPendingShowsSynced() {
        let lastSync = Date(timeIntervalSince1970: 1_700_000_000)
        let ws = makeWorkspace(syncStatus: .idle, pendingCount: 0, lastSyncAt: lastSync)
        let text = app.syncStatusText(for: ws)
        XCTAssertTrue(text.hasPrefix("Synced · "), "expected 'Synced · …', got '\(text)'")
        XCTAssertFalse(text.contains("behind"))
    }

    func testSyncStatusTextIdleWithPendingShowsFilesBehind() {
        let lastSync = Date(timeIntervalSince1970: 1_700_000_000)
        let ws = makeWorkspace(syncStatus: .idle, pendingCount: 3, lastSyncAt: lastSync)
        let text = app.syncStatusText(for: ws)
        XCTAssertTrue(text.contains("3 files behind"), "expected '3 files behind', got '\(text)'")
        XCTAssertTrue(text.contains("Synced "), "expected to include last-sync time, got '\(text)'")
    }

    func testSyncStatusTextIdleWithSinglePendingUsesSingularNoun() {
        let lastSync = Date(timeIntervalSince1970: 1_700_000_000)
        let ws = makeWorkspace(syncStatus: .idle, pendingCount: 1, lastSyncAt: lastSync)
        let text = app.syncStatusText(for: ws)
        XCTAssertTrue(text.contains("1 file behind"), "expected '1 file behind' (singular), got '\(text)'")
        XCTAssertFalse(text.contains("files behind"))
    }

    func testSyncStatusTextIdleWithPendingButNoLastSync() {
        let ws = makeWorkspace(syncStatus: .idle, pendingCount: 5, lastSyncAt: nil)
        let text = app.syncStatusText(for: ws)
        XCTAssertEqual(text, "5 files behind")
    }

    func testSyncStatusTextSyncingStillShowsCount() {
        let ws = makeWorkspace(syncStatus: .syncing, pendingCount: 4, lastSyncAt: nil)
        let text = app.syncStatusText(for: ws)
        XCTAssertEqual(text, "Syncing… (4 files)")
    }

    // MARK: - S85 revoke-on-sign-out (fail-open + visible)

    /// /revoke fails (localhost:0 → URLError.cannotConnectToHost). The
    /// revoke-warning presenter must fire AND local state must still be fully
    /// cleared.
    func testRevokeFailureSurfacesWarningAndStillSignsOutLocally() async throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        let folder = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        wireFirstRunForTest(app, folder: folder)
        app.applyBearer(workspaceID: id, bearer: "bearer-to-revoke-S85")
        XCTAssertEqual(app.workspaces.count, 1)

        var alertCount = 0
        app.presentRevokeWarning = { alertCount += 1 }

        await app.signOut(workspaceID: id)

        XCTAssertEqual(alertCount, 1, "Warning presenter must fire on revoke failure")
        XCTAssertNil(try keychain.retrieve(workspaceID: id))
        XCTAssertTrue(app.workspaces.isEmpty, "Workspace must be removed even when revoke failed")
    }

    /// No bearer for the workspace → no revoke attempt → no warning.
    func testNoBearerSkipsRevokeAndNoWarning() async throws {
        let id = UUID()
        defer { cleanSettingsDefaults(for: id) }
        // No applyBearer — workspaces stays empty, no bearer to revoke.
        var alertCount = 0
        app.presentRevokeWarning = { alertCount += 1 }

        await app.performSignOut(workspaceID: id)

        XCTAssertEqual(alertCount, 0, "No revoke attempt → no warning")
    }
}
