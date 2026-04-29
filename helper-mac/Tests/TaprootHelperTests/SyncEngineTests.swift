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
