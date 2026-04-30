import XCTest
@testable import TaprootHelper

/// Wire-shape struct used to decode the body the engine sent for assertions.
/// Mirrors the server's zod schema, but with all-optional content/mtime so
/// delete ops decode cleanly when those fields are omitted.
private struct DecodedOp: Decodable {
    let kind: String
    let path: String
    let content: String?
    let mtime: String?
}

private struct DecodedBody: Decodable {
    let ops: [DecodedOp]
}

final class SyncEngineTests: XCTestCase {
    private var tmpDir: URL!
    private let baseURL = URL(string: "https://example.test")!

    override func setUpWithError() throws {
        let base = FileManager.default.temporaryDirectory
        tmpDir = base.appendingPathComponent("taproot-syncengine-tests-\(UUID().uuidString)")
            .resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let tmpDir, FileManager.default.fileExists(atPath: tmpDir.path) {
            try? FileManager.default.removeItem(at: tmpDir)
        }
    }

    // MARK: - helpers

    private func makeSnapshot(folder: URL? = nil) -> WorkspaceSnapshot {
        WorkspaceSnapshot(
            id: UUID(),
            bearer: "test-bearer",
            localFolder: folder ?? tmpDir
        )
    }

    private func makeFile(name: String, contents: String) throws -> URL {
        let url = tmpDir.appendingPathComponent(name)
        try Data(contents.utf8).write(to: url)
        return url
    }

    // MARK: - tests

    func testPushSendsRequestToCorrectURL() async throws {
        let fake = FakeHTTPClient()
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let url = try makeFile(name: "a.md", contents: "hello")
        let snapshot = makeSnapshot()
        let event = FileChangeEvent(path: url, kind: .created, mtime: nil)

        await engine.push(workspace: snapshot, events: [event])

        let count = await fake.sendCount
        XCTAssertEqual(count, 1)
        let lastReq = await fake.lastRequest
        let req = try XCTUnwrap(lastReq)
        XCTAssertEqual(req.url.absoluteString, "https://example.test/api/sync/push")
        XCTAssertEqual(req.method, "POST")
        XCTAssertEqual(req.headers["Content-Type"], "application/json")
        XCTAssertEqual(req.headers["Authorization"], "Bearer test-bearer")
    }

    func testPushBodyContainsExpectedOps() async throws {
        let fake = FakeHTTPClient()
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let createURL = try makeFile(name: "c.md", contents: "create-body")
        let modifyURL = try makeFile(name: "m.md", contents: "modify-body")
        let deleteURL = tmpDir.appendingPathComponent("d.md") // never created on disk

        let mtime = Date(timeIntervalSince1970: 1_700_000_000)
        let snapshot = makeSnapshot()
        let events = [
            FileChangeEvent(path: createURL, kind: .created, mtime: mtime),
            FileChangeEvent(path: modifyURL, kind: .modified, mtime: mtime),
            FileChangeEvent(path: deleteURL, kind: .deleted, mtime: nil),
        ]

        await engine.push(workspace: snapshot, events: events)

        let lastReq = await fake.lastRequest
        let req = try XCTUnwrap(lastReq)
        let decoded = try JSONDecoder().decode(DecodedBody.self, from: req.body)
        XCTAssertEqual(decoded.ops.count, 3)

        let create = try XCTUnwrap(decoded.ops.first { $0.path == "c.md" })
        XCTAssertEqual(create.kind, "upsert")
        XCTAssertEqual(create.content, "create-body")
        XCTAssertNotNil(create.mtime)

        let modify = try XCTUnwrap(decoded.ops.first { $0.path == "m.md" })
        XCTAssertEqual(modify.kind, "upsert")
        XCTAssertEqual(modify.content, "modify-body")

        let del = try XCTUnwrap(decoded.ops.first { $0.path == "d.md" })
        XCTAssertEqual(del.kind, "delete")
        XCTAssertNil(del.content, "delete op must omit content (encodeIfPresent)")
        XCTAssertNil(del.mtime, "delete op must omit mtime")
    }

    func testPushRelativizesPathsAgainstLocalFolder() async throws {
        let fake = FakeHTTPClient()
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let nestedDir = tmpDir.appendingPathComponent("subdir")
        try FileManager.default.createDirectory(at: nestedDir, withIntermediateDirectories: true)
        let nestedFile = nestedDir.appendingPathComponent("nested.md")
        try Data("nested".utf8).write(to: nestedFile)

        let snapshot = makeSnapshot()
        let event = FileChangeEvent(path: nestedFile, kind: .created, mtime: nil)
        await engine.push(workspace: snapshot, events: [event])

        let lastReq = await fake.lastRequest
        let req = try XCTUnwrap(lastReq)
        let decoded = try JSONDecoder().decode(DecodedBody.self, from: req.body)
        XCTAssertEqual(decoded.ops.first?.path, "subdir/nested.md")
    }

    func testPushDropsEventsOutsideLocalFolder() async throws {
        let fake = FakeHTTPClient()
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let outside = URL(fileURLWithPath: "/private/var/tmp/not-in-workspace.md")
        let snapshot = makeSnapshot()
        let event = FileChangeEvent(path: outside, kind: .modified, mtime: nil)

        await engine.push(workspace: snapshot, events: [event])

        let count = await fake.sendCount
        XCTAssertEqual(count, 0, "Outside-folder events must produce no HTTP send")
    }

    /// N3 (build-audit-3): symmetric with pull's safeJoin invariant. FSEvents
    /// canonicalizes in practice so this case is unlikely, but a defense-in-depth
    /// guard catches any future code path that might feed non-canonical events
    /// (with `..` segments) into toOp.
    func testPushRefusesParentTraversalInRelativePath() async throws {
        let fake = FakeHTTPClient()
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let snapshot = makeSnapshot()
        // Structurally inside the workspace prefix, but a `..` segment after
        // relativize would let it escape. URL.appendingPathComponent does not
        // standardize, so the literal `..` survives into toOp.
        let traversal = snapshot.localFolder.appendingPathComponent("a/../../etc/passwd")
        let event = FileChangeEvent(path: traversal, kind: .modified, mtime: nil)

        await engine.push(workspace: snapshot, events: [event])

        let count = await fake.sendCount
        XCTAssertEqual(count, 0, "Events with `..` in relativized path must be rejected")
    }

    /// Locks the §5 invariant: when the caller has resolved symlinks on the
    /// snapshot folder (per AppDelegate's two construction sites), watcher
    /// events with canonical paths get accepted. Regression guard against
    /// removing that resolution upstream.
    func testPushHandlesSymlinkedLocalFolder() async throws {
        // Build: realDir is canonical. symlinkDir → realDir. WorkspaceWatcher
        // canonicalizes event paths. Simulate that by passing canonical paths
        // for both snapshot folder and event path.
        let realDir = tmpDir.appendingPathComponent("real")
        try FileManager.default.createDirectory(at: realDir, withIntermediateDirectories: true)
        let symlinkParent = tmpDir.appendingPathComponent("link-parent")
        try FileManager.default.createSymbolicLink(at: symlinkParent, withDestinationURL: realDir)

        // The AppDelegate fix in §5 wraps construction with `.resolvingSymlinksInPath()`,
        // so the snapshot folder arrives canonical. Replicate that here.
        let resolvedFolder = symlinkParent.resolvingSymlinksInPath()
        XCTAssertEqual(resolvedFolder.path, realDir.resolvingSymlinksInPath().path)

        let fake = FakeHTTPClient()
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let fileURL = realDir.appendingPathComponent("under-link.md")
        try Data("via-symlink".utf8).write(to: fileURL)

        let snapshot = WorkspaceSnapshot(
            id: UUID(),
            bearer: "b",
            localFolder: resolvedFolder
        )
        let event = FileChangeEvent(
            path: fileURL.resolvingSymlinksInPath(),
            kind: .created,
            mtime: nil
        )
        await engine.push(workspace: snapshot, events: [event])

        let count = await fake.sendCount
        XCTAssertEqual(count, 1, "Resolved-folder + canonical-event must accept")
        let lastReq = await fake.lastRequest
        let req = try XCTUnwrap(lastReq)
        let decoded = try JSONDecoder().decode(DecodedBody.self, from: req.body)
        XCTAssertEqual(decoded.ops.first?.path, "under-link.md")
    }

    func testPushDropsContentReadFailureForUpsert() async throws {
        let fake = FakeHTTPClient()
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)

        let realFile = try makeFile(name: "kept.md", contents: "still-here")
        let goneFile = tmpDir.appendingPathComponent("gone.md") // never written
        let snapshot = makeSnapshot()

        await engine.push(workspace: snapshot, events: [
            FileChangeEvent(path: goneFile, kind: .modified, mtime: nil),
            FileChangeEvent(path: realFile, kind: .created, mtime: nil),
        ])

        let count = await fake.sendCount
        XCTAssertEqual(count, 1, "Batch must send when at least one op survives read")
        let lastReq = await fake.lastRequest
        let req = try XCTUnwrap(lastReq)
        let decoded = try JSONDecoder().decode(DecodedBody.self, from: req.body)
        XCTAssertEqual(decoded.ops.count, 1, "Failed-read op must be dropped from batch")
        XCTAssertEqual(decoded.ops.first?.path, "kept.md")
    }

    func testPushHandles401ByCallingOnUnauthorized() async throws {
        let fake = FakeHTTPClient()
        await fake.setStubbedResponse(.success(HTTPResponse(status: 401, body: Data())))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)

        let workspaceID = UUID()
        let unauthorizedExp = expectation(description: "onUnauthorized called")
        let captured = ActorBox<UUID>()

        await engine.setOnUnauthorized { id in
            captured.set(id)
            unauthorizedExp.fulfill()
        }

        let url = try makeFile(name: "x.md", contents: "data")
        let snapshot = WorkspaceSnapshot(id: workspaceID, bearer: "stale", localFolder: tmpDir)
        let event = FileChangeEvent(path: url, kind: .created, mtime: nil)

        await engine.push(workspace: snapshot, events: [event])

        await fulfillment(of: [unauthorizedExp], timeout: 2.0)
        XCTAssertEqual(captured.get(), workspaceID)
    }

    func testPushIgnores500WithoutCrashOrSignOut() async throws {
        let fake = FakeHTTPClient()
        await fake.setStubbedResponse(.success(HTTPResponse(status: 500, body: Data("oops".utf8))))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)

        let captured = ActorBox<UUID>()
        await engine.setOnUnauthorized { id in captured.set(id) }

        let url = try makeFile(name: "y.md", contents: "data")
        let snapshot = makeSnapshot()
        let event = FileChangeEvent(path: url, kind: .created, mtime: nil)

        await engine.push(workspace: snapshot, events: [event])

        // 100ms gives any spurious dispatch a chance to fire.
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertNil(captured.get(), "5xx must NOT trigger sign-out")
    }

    func testPushHandlesNetworkFailure() async throws {
        let fake = FakeHTTPClient()
        await fake.setStubbedResponse(.failure(URLError(.notConnectedToInternet)))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)

        let captured = ActorBox<UUID>()
        await engine.setOnUnauthorized { id in captured.set(id) }

        let url = try makeFile(name: "z.md", contents: "data")
        let snapshot = makeSnapshot()
        let event = FileChangeEvent(path: url, kind: .created, mtime: nil)

        // Must not throw even though stub yields URLError.
        await engine.push(workspace: snapshot, events: [event])

        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertNil(captured.get(), "Transport errors must NOT trigger sign-out (Stage 1 drop semantics)")
    }

    // MARK: - Pull tests (T11.4)

    private func stubPullResponse(_ json: String, status: Int = 200) -> HTTPResponse {
        HTTPResponse(status: status, body: Data(json.utf8))
    }

    func testPullSendsRequestToCorrectURLWithCursor() async throws {
        let fake = FakeHTTPClient()
        await fake.setStubbedResponse(.success(stubPullResponse(
            "{\"files\":[],\"next_since\":null,\"next_since_id\":null}"
        )))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let snapshot = makeSnapshot()
        let cursor = PullCursor(
            modifiedAt: "2026-04-29T05:00:00.000Z",
            id: "00000000-0000-4000-8000-000000000001"
        )
        let tracker = ApplyTracker()
        _ = await engine.pull(
            workspace: snapshot,
            cursor: cursor,
            applyWrite: { url, content in await tracker.recordWrite(url, content) },
            applyDelete: { url in await tracker.recordDelete(url) }
        )

        let lastReq = await fake.lastRequest
        let req = try XCTUnwrap(lastReq)
        XCTAssertEqual(req.method, "GET")
        XCTAssertEqual(req.headers["Authorization"], "Bearer test-bearer")
        let comps = try XCTUnwrap(URLComponents(url: req.url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(comps.path, "/api/sync/pull")
        let items = comps.queryItems ?? []
        XCTAssertTrue(items.contains(URLQueryItem(name: "limit", value: "500")))
        XCTAssertTrue(items.contains(URLQueryItem(name: "since", value: cursor.modifiedAt)))
        XCTAssertTrue(items.contains(URLQueryItem(name: "since_id", value: cursor.id)))
    }

    func testPullSendsRequestWithNoCursorOnInitial() async throws {
        let fake = FakeHTTPClient()
        await fake.setStubbedResponse(.success(stubPullResponse(
            "{\"files\":[],\"next_since\":null,\"next_since_id\":null}"
        )))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let snapshot = makeSnapshot()
        let tracker = ApplyTracker()
        _ = await engine.pull(
            workspace: snapshot,
            cursor: nil,
            applyWrite: { url, content in await tracker.recordWrite(url, content) },
            applyDelete: { url in await tracker.recordDelete(url) }
        )

        let lastReq = await fake.lastRequest
        let req = try XCTUnwrap(lastReq)
        let comps = try XCTUnwrap(URLComponents(url: req.url, resolvingAgainstBaseURL: false))
        let names = (comps.queryItems ?? []).map(\.name)
        XCTAssertTrue(names.contains("limit"))
        XCTAssertFalse(names.contains("since"), "no cursor → no since")
        XCTAssertFalse(names.contains("since_id"), "no cursor → no since_id")
    }

    func testPullEmptyResponseReturnsCaughtUpAndDoesNotApply() async throws {
        let fake = FakeHTTPClient()
        await fake.setStubbedResponse(.success(stubPullResponse(
            "{\"files\":[],\"next_since\":null,\"next_since_id\":null}"
        )))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let snapshot = makeSnapshot()
        let tracker = ApplyTracker()

        let outcome = await engine.pull(
            workspace: snapshot,
            cursor: nil,
            applyWrite: { url, content in await tracker.recordWrite(url, content) },
            applyDelete: { url in await tracker.recordDelete(url) }
        )

        switch outcome {
        case .caughtUp(let next): XCTAssertNil(next)
        default: XCTFail("expected .caughtUp(nil), got \(outcome)")
        }
        let writes = await tracker.snapshotWrites()
        let deletes = await tracker.snapshotDeletes()
        XCTAssertEqual(writes.count, 0)
        XCTAssertEqual(deletes.count, 0)
    }

    func testPullSingleFileResponseAppliesWrite() async throws {
        let fake = FakeHTTPClient()
        let json = """
        {"files":[{"path":"hello.md","size":5,"mtime":"2026-04-29T05:00:00.000Z","deleted":false,"content":"hello"}],
         "next_since":"2026-04-29T05:00:00.000Z","next_since_id":"00000000-0000-4000-8000-000000000001"}
        """
        await fake.setStubbedResponse(.success(stubPullResponse(json)))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let snapshot = makeSnapshot()
        let tracker = ApplyTracker()

        let outcome = await engine.pull(
            workspace: snapshot,
            cursor: nil,
            applyWrite: { url, content in await tracker.recordWrite(url, content) },
            applyDelete: { url in await tracker.recordDelete(url) }
        )

        let writes = await tracker.snapshotWrites()
        XCTAssertEqual(writes.count, 1)
        XCTAssertEqual(writes.first?.0.path, tmpDir.appendingPathComponent("hello.md").path)
        XCTAssertEqual(writes.first?.1, "hello")
        switch outcome {
        case .caughtUp(let next):
            XCTAssertEqual(next?.modifiedAt, "2026-04-29T05:00:00.000Z")
            XCTAssertEqual(next?.id, "00000000-0000-4000-8000-000000000001")
        default: XCTFail("expected .caughtUp, got \(outcome)")
        }
    }

    func testPullPaginatedResponseReturnsMorePages() async throws {
        // limit=2 + 2 returned files = full page → .morePages
        let fake = FakeHTTPClient()
        let json = """
        {"files":[
            {"path":"a.md","size":1,"mtime":"2026-04-29T05:00:00.000Z","deleted":false,"content":"a"},
            {"path":"b.md","size":1,"mtime":"2026-04-29T05:00:01.000Z","deleted":false,"content":"b"}
        ],"next_since":"2026-04-29T05:00:01.000Z","next_since_id":"00000000-0000-4000-8000-000000000002"}
        """
        await fake.setStubbedResponse(.success(stubPullResponse(json)))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let tracker = ApplyTracker()

        let outcome = await engine.pull(
            workspace: makeSnapshot(),
            cursor: nil,
            limit: 2,
            applyWrite: { url, content in await tracker.recordWrite(url, content) },
            applyDelete: { url in await tracker.recordDelete(url) }
        )

        switch outcome {
        case .morePages(let cursor):
            XCTAssertEqual(cursor.modifiedAt, "2026-04-29T05:00:01.000Z")
            XCTAssertEqual(cursor.id, "00000000-0000-4000-8000-000000000002")
        default: XCTFail("expected .morePages, got \(outcome)")
        }
    }

    func testPullDeletionResponseAppliesDelete() async throws {
        let fake = FakeHTTPClient()
        let json = """
        {"files":[{"path":"gone.md","size":0,"mtime":"2026-04-29T05:00:00.000Z","deleted":true}],
         "next_since":"2026-04-29T05:00:00.000Z","next_since_id":"00000000-0000-4000-8000-000000000001"}
        """
        await fake.setStubbedResponse(.success(stubPullResponse(json)))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let tracker = ApplyTracker()

        _ = await engine.pull(
            workspace: makeSnapshot(),
            cursor: nil,
            applyWrite: { url, content in await tracker.recordWrite(url, content) },
            applyDelete: { url in await tracker.recordDelete(url) }
        )

        let writes = await tracker.snapshotWrites()
        let deletes = await tracker.snapshotDeletes()
        XCTAssertEqual(writes.count, 0, "deleted entry must not call applyWrite")
        XCTAssertEqual(deletes.count, 1)
        XCTAssertEqual(deletes.first?.path, tmpDir.appendingPathComponent("gone.md").path)
    }

    func testPullCursorAdvancesOnPartialPage() async throws {
        // 2 entries vs limit=500 = partial page → .caughtUp with cursor of LAST returned row
        let fake = FakeHTTPClient()
        let json = """
        {"files":[
            {"path":"a.md","size":1,"mtime":"2026-04-29T05:00:00.000Z","deleted":false,"content":"a"},
            {"path":"b.md","size":1,"mtime":"2026-04-29T05:00:01.000Z","deleted":false,"content":"b"}
        ],"next_since":"2026-04-29T05:00:01.000Z","next_since_id":"00000000-0000-4000-8000-000000000002"}
        """
        await fake.setStubbedResponse(.success(stubPullResponse(json)))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let tracker = ApplyTracker()

        let outcome = await engine.pull(
            workspace: makeSnapshot(),
            cursor: nil,
            limit: 500,
            applyWrite: { url, content in await tracker.recordWrite(url, content) },
            applyDelete: { url in await tracker.recordDelete(url) }
        )

        switch outcome {
        case .caughtUp(let cursor):
            XCTAssertEqual(cursor?.modifiedAt, "2026-04-29T05:00:01.000Z")
            XCTAssertEqual(cursor?.id, "00000000-0000-4000-8000-000000000002")
        default: XCTFail("expected .caughtUp(cursor), got \(outcome)")
        }
    }

    func testPullHandles401ByCallingOnUnauthorized() async throws {
        let fake = FakeHTTPClient()
        await fake.setStubbedResponse(.success(HTTPResponse(status: 401, body: Data())))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)

        let workspaceID = UUID()
        let unauthorizedExp = expectation(description: "onUnauthorized called")
        let captured = ActorBox<UUID>()
        await engine.setOnUnauthorized { id in
            captured.set(id)
            unauthorizedExp.fulfill()
        }

        let snapshot = WorkspaceSnapshot(id: workspaceID, bearer: "stale", localFolder: tmpDir)
        let tracker = ApplyTracker()
        let outcome = await engine.pull(
            workspace: snapshot,
            cursor: nil,
            applyWrite: { url, content in await tracker.recordWrite(url, content) },
            applyDelete: { url in await tracker.recordDelete(url) }
        )

        await fulfillment(of: [unauthorizedExp], timeout: 2.0)
        XCTAssertEqual(captured.get(), workspaceID)
        switch outcome {
        case .transportError: break
        default: XCTFail("401 must surface as .transportError, got \(outcome)")
        }
    }

    func testPullHandlesTransportErrorGracefully() async throws {
        let fake = FakeHTTPClient()
        await fake.setStubbedResponse(.failure(URLError(.notConnectedToInternet)))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let captured = ActorBox<UUID>()
        await engine.setOnUnauthorized { id in captured.set(id) }
        let tracker = ApplyTracker()

        let outcome = await engine.pull(
            workspace: makeSnapshot(),
            cursor: nil,
            applyWrite: { url, content in await tracker.recordWrite(url, content) },
            applyDelete: { url in await tracker.recordDelete(url) }
        )

        switch outcome {
        case .transportError: break
        default: XCTFail("URLError must surface as .transportError, got \(outcome)")
        }
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertNil(captured.get(), "transport errors must NOT trigger sign-out")
    }

    func testPullPathTraversalRejected() async throws {
        let fake = FakeHTTPClient()
        let json = """
        {"files":[{"path":"../escape.md","size":3,"mtime":"2026-04-29T05:00:00.000Z","deleted":false,"content":"esc"}],
         "next_since":"2026-04-29T05:00:00.000Z","next_since_id":"00000000-0000-4000-8000-000000000001"}
        """
        await fake.setStubbedResponse(.success(stubPullResponse(json)))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let tracker = ApplyTracker()

        _ = await engine.pull(
            workspace: makeSnapshot(),
            cursor: nil,
            applyWrite: { url, content in await tracker.recordWrite(url, content) },
            applyDelete: { url in await tracker.recordDelete(url) }
        )

        let writes = await tracker.snapshotWrites()
        let deletes = await tracker.snapshotDeletes()
        XCTAssertEqual(writes.count, 0, "../escape.md must be rejected by safeJoin")
        XCTAssertEqual(deletes.count, 0)
    }

    func testPullAliveEntryWithoutContentIsSkipped() async throws {
        let fake = FakeHTTPClient()
        // Defensive against server bug — alive entries should always carry content
        // per D1.a; if they don't, helper skips rather than writing empty.
        let json = """
        {"files":[{"path":"buggy.md","size":5,"mtime":"2026-04-29T05:00:00.000Z","deleted":false}],
         "next_since":"2026-04-29T05:00:00.000Z","next_since_id":"00000000-0000-4000-8000-000000000001"}
        """
        await fake.setStubbedResponse(.success(stubPullResponse(json)))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let tracker = ApplyTracker()

        let outcome = await engine.pull(
            workspace: makeSnapshot(),
            cursor: nil,
            applyWrite: { url, content in await tracker.recordWrite(url, content) },
            applyDelete: { url in await tracker.recordDelete(url) }
        )

        let writes = await tracker.snapshotWrites()
        XCTAssertEqual(writes.count, 0, "alive entry without content must skip applyWrite")
        // tick still completes cleanly with cursor advanced
        switch outcome {
        case .caughtUp: break
        default: XCTFail("expected .caughtUp despite skip, got \(outcome)")
        }
    }

    // MARK: - safeJoin pure-function tests

    func testSafeJoinRejectsAbsolute() {
        let folder = URL(fileURLWithPath: "/tmp/wks")
        XCTAssertNil(SyncEngine.safeJoin(folder: folder, relative: "/etc/passwd"))
    }

    func testSafeJoinRejectsParentEscape() {
        let folder = URL(fileURLWithPath: "/tmp/wks")
        XCTAssertNil(SyncEngine.safeJoin(folder: folder, relative: "../escape.md"))
        XCTAssertNil(SyncEngine.safeJoin(folder: folder, relative: "sub/../../escape.md"))
    }

    func testSafeJoinAcceptsCleanRelative() {
        let folder = URL(fileURLWithPath: "/tmp/wks")
        let target = SyncEngine.safeJoin(folder: folder, relative: "sub/file.md")
        XCTAssertEqual(target?.path, "/tmp/wks/sub/file.md")
    }
}

/// Tracks `applyWrite` / `applyDelete` invocations across the pull burst.
/// `actor` so we can append from @MainActor closures and snapshot from the
/// test body without lock dancing.
private actor ApplyTracker {
    private var writes: [(URL, String)] = []
    private var deletes: [URL] = []

    func recordWrite(_ url: URL, _ content: String) {
        writes.append((url, content))
    }

    func recordDelete(_ url: URL) {
        deletes.append(url)
    }

    func snapshotWrites() -> [(URL, String)] { writes }
    func snapshotDeletes() -> [URL] { deletes }
}

/// Sendable, lock-protected single-value box. The `@MainActor` `onUnauthorized`
/// handler runs on the main actor; we capture the argument here for sync-side
/// inspection from the test body without needing an `await` boundary.
private final class ActorBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T?
    func set(_ v: T) { lock.lock(); value = v; lock.unlock() }
    func get() -> T? { lock.lock(); defer { lock.unlock() }; return value }
}

// MARK: - T11.8 commit 6 — pushInFlight counter

extension SyncEngineTests {
    func testPushInFlightStartsAtZero() {
        let engine = SyncEngine(httpClient: FakeHTTPClient(), baseURL: baseURL)
        XCTAssertEqual(engine.pushInFlight, 0)
    }

    func testPushInFlightCounterIncrementsDuringSend() async throws {
        let fake = FakeHTTPClient()
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let url = try makeFile(name: "a.md", contents: "hi")
        let snap = makeSnapshot()
        let event = FileChangeEvent(path: url, kind: .created, mtime: nil)

        // Capture the counter at the moment the fake receives the request —
        // i.e. inside the increment + before the defer-decrement fires.
        let captured = ActorBox<Int32>()
        await fake.setOnSend { [engine] in
            captured.set(engine.pushInFlight)
        }

        await engine.push(workspace: snap, events: [event])

        XCTAssertEqual(captured.get(), 1,
                       "Counter must read 1 during the HTTP send (post-increment, pre-defer)")
        XCTAssertEqual(engine.pushInFlight, 0,
                       "defer must restore counter to 0 after push completes")
    }

    func testPushInFlightDecrementsOnTransportFailure() async throws {
        let fake = FakeHTTPClient()
        await fake.setStubbedResponse(.failure(URLError(.notConnectedToInternet)))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let url = try makeFile(name: "a.md", contents: "hi")
        let snap = makeSnapshot()
        let event = FileChangeEvent(path: url, kind: .created, mtime: nil)

        await engine.push(workspace: snap, events: [event])

        XCTAssertEqual(engine.pushInFlight, 0,
                       "Counter must restore to 0 even when the HTTP send throws")
    }

    func testPushInFlightDecrementsOn401() async throws {
        let fake = FakeHTTPClient()
        await fake.setStubbedResponse(.success(HTTPResponse(status: 401, body: Data())))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let url = try makeFile(name: "a.md", contents: "hi")
        let snap = makeSnapshot()
        let event = FileChangeEvent(path: url, kind: .created, mtime: nil)

        await engine.push(workspace: snap, events: [event])

        XCTAssertEqual(engine.pushInFlight, 0,
                       "401 path also exits via defer; counter must drain")
    }

    func testPushInFlightDoesNotIncrementOnEarlyReturn() async {
        let engine = SyncEngine(httpClient: FakeHTTPClient(), baseURL: baseURL)
        let snap = makeSnapshot()

        // No events → push() returns before the counter gates.
        await engine.push(workspace: snap, events: [])

        XCTAssertEqual(engine.pushInFlight, 0,
                       "Empty-events early-return must not bump the counter")
    }

    func testConcurrentPushesAccumulateInFlight() async throws {
        let fake = FakeHTTPClient()
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let url1 = try makeFile(name: "a.md", contents: "hi-a")
        let url2 = try makeFile(name: "b.md", contents: "hi-b")

        let observed = ActorBox<Int32>()
        var maxObserved: Int32 = 0
        let observedLock = NSLock()
        await fake.setOnSend { [engine] in
            let snap = engine.pushInFlight
            observed.set(snap)
            observedLock.lock()
            if snap > maxObserved { maxObserved = snap }
            observedLock.unlock()
        }

        async let p1: Void = engine.push(
            workspace: makeSnapshot(),
            events: [FileChangeEvent(path: url1, kind: .created, mtime: nil)]
        )
        async let p2: Void = engine.push(
            workspace: makeSnapshot(),
            events: [FileChangeEvent(path: url2, kind: .created, mtime: nil)]
        )
        _ = await (p1, p2)

        // Two pushes against an actor serialize through the actor's
        // mailbox. Each one's HTTP send happens in turn — but the counter
        // increment is non-actor-isolated (lock-based), so even serialized
        // sends see >=1 during their own window. Lock the post-condition:
        // counter drains to 0 once both finish.
        XCTAssertEqual(engine.pushInFlight, 0,
                       "All in-flight counts must drain after concurrent pushes complete")
        XCTAssertGreaterThanOrEqual(maxObserved, 1,
                                    "At least one onSend snapshot must observe counter >= 1")
    }
}
