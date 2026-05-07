import XCTest
@testable import TaprootHelper

/// Phase 1 (0.1.5) tests for `InitialSyncCoordinator`. Mirrors the
/// `SyncEngineTests` style with `FakeHTTPClient` for stubbing.
final class InitialSyncCoordinatorTests: XCTestCase {
    private var tmpDir: URL!
    private let baseURL = URL(string: "https://example.test")!

    override func setUpWithError() throws {
        let base = FileManager.default.temporaryDirectory
        tmpDir = base.appendingPathComponent("taproot-initialsync-tests-\(UUID().uuidString)")
            .resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let tmpDir, FileManager.default.fileExists(atPath: tmpDir.path) {
            try? FileManager.default.removeItem(at: tmpDir)
        }
    }

    // MARK: - helpers

    private func makeFile(_ relativePath: String, contents: String) throws -> URL {
        let url = tmpDir.appendingPathComponent(relativePath)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data(contents.utf8).write(to: url)
        return url
    }

    private func snapshot() -> WorkspaceSnapshot {
        WorkspaceSnapshot(id: UUID(), bearer: "test-bearer", localFolder: tmpDir)
    }

    private func okResponse(_ body: [String: Any] = ["results": []]) -> HTTPResponse {
        let data = try! JSONSerialization.data(withJSONObject: body)
        return HTTPResponse(status: 200, body: data)
    }

    private func makeCoordinator(
        engine: SyncEngine,
        maxBatchSize: Int = 500,
        maxRetriesPerBatch: Int = 3,
        backoff: @Sendable @escaping (Int) -> UInt64 = { _ in 0 }
    ) -> InitialSyncCoordinator {
        InitialSyncCoordinator(
            syncEngine: engine,
            maxBatchSize: maxBatchSize,
            maxRetriesPerBatch: maxRetriesPerBatch,
            backoffNanoseconds: backoff
        )
    }

    private struct DecodedOp: Decodable {
        let kind: String
        let path: String
        let content: String?
    }
    private struct DecodedBody: Decodable {
        let ops: [DecodedOp]
    }

    // MARK: - walk

    func testWalkExistingFilesProducesUpsertOps() async throws {
        _ = try makeFile("a.md", contents: "alpha")
        _ = try makeFile("b.md", contents: "bravo")
        _ = try makeFile("c.md", contents: "charlie")

        let fake = FakeHTTPClient()
        await fake.setStubbedResponse(.success(okResponse()))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let coordinator = makeCoordinator(engine: engine)

        var seen: [InitialSyncCoordinator.Progress] = []
        try await coordinator.run(workspace: snapshot()) { p in seen.append(p) }

        XCTAssertEqual(seen.last?.phase, .completed)
        XCTAssertEqual(seen.last?.total, 3)
        let lastReq = await fake.lastRequest
        let req = try XCTUnwrap(lastReq)
        let body = try JSONDecoder().decode(DecodedBody.self, from: req.body)
        let paths = Set(body.ops.map { $0.path })
        XCTAssertEqual(paths, ["a.md", "b.md", "c.md"])
        for op in body.ops {
            XCTAssertEqual(op.kind, "upsert")
            XCTAssertNotNil(op.content)
        }
    }

    func testWalkSkipsHiddenFiles() async throws {
        _ = try makeFile("visible.md", contents: "v")
        _ = try makeFile(".hidden.md", contents: "h")
        _ = try makeFile(".DS_Store", contents: "ds")

        let fake = FakeHTTPClient()
        await fake.setStubbedResponse(.success(okResponse()))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let coordinator = makeCoordinator(engine: engine)

        try await coordinator.run(workspace: snapshot()) { _ in }

        let lastReq = await fake.lastRequest
        let req = try XCTUnwrap(lastReq)
        let body = try JSONDecoder().decode(DecodedBody.self, from: req.body)
        let paths = body.ops.map { $0.path }
        XCTAssertEqual(paths, ["visible.md"])
    }

    func testWalkSkipsObsidianFolder() async throws {
        _ = try makeFile("notes/keep.md", contents: "k")
        _ = try makeFile(".obsidian/config.json", contents: "{}")
        _ = try makeFile(".obsidian/plugins/foo.json", contents: "{}")

        let fake = FakeHTTPClient()
        await fake.setStubbedResponse(.success(okResponse()))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let coordinator = makeCoordinator(engine: engine)

        try await coordinator.run(workspace: snapshot()) { _ in }

        let lastReq = await fake.lastRequest
        let req = try XCTUnwrap(lastReq)
        let body = try JSONDecoder().decode(DecodedBody.self, from: req.body)
        XCTAssertEqual(body.ops.map { $0.path }, ["notes/keep.md"])
    }

    func testWalkSkipsSymlinks() async throws {
        let real = try makeFile("real.md", contents: "real")
        let link = tmpDir.appendingPathComponent("link.md")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)

        let fake = FakeHTTPClient()
        await fake.setStubbedResponse(.success(okResponse()))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let coordinator = makeCoordinator(engine: engine)

        try await coordinator.run(workspace: snapshot()) { _ in }

        let lastReq = await fake.lastRequest
        let req = try XCTUnwrap(lastReq)
        let body = try JSONDecoder().decode(DecodedBody.self, from: req.body)
        XCTAssertEqual(body.ops.map { $0.path }, ["real.md"])
    }

    func testWalkSkipsDirectories() async throws {
        _ = try makeFile("a.md", contents: "a")
        // Empty directory — should not be sent as an op.
        try FileManager.default.createDirectory(
            at: tmpDir.appendingPathComponent("emptydir"),
            withIntermediateDirectories: true
        )

        let fake = FakeHTTPClient()
        await fake.setStubbedResponse(.success(okResponse()))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let coordinator = makeCoordinator(engine: engine)

        try await coordinator.run(workspace: snapshot()) { _ in }

        let lastReq = await fake.lastRequest
        let req = try XCTUnwrap(lastReq)
        let body = try JSONDecoder().decode(DecodedBody.self, from: req.body)
        XCTAssertEqual(body.ops.map { $0.path }, ["a.md"])
    }

    func testWalkSkipsBinaryNonUtf8Files() async throws {
        // Valid UTF-8 file
        _ = try makeFile("text.md", contents: "hello")
        // Invalid UTF-8 (a stray continuation byte)
        let binaryURL = tmpDir.appendingPathComponent("blob.bin")
        try Data([0xFF, 0xFE, 0x80, 0x80]).write(to: binaryURL)

        let fake = FakeHTTPClient()
        await fake.setStubbedResponse(.success(okResponse()))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let coordinator = makeCoordinator(engine: engine)

        try await coordinator.run(workspace: snapshot()) { _ in }

        let lastReq = await fake.lastRequest
        let req = try XCTUnwrap(lastReq)
        let body = try JSONDecoder().decode(DecodedBody.self, from: req.body)
        XCTAssertEqual(body.ops.map { $0.path }, ["text.md"])
    }

    // MARK: - chunking

    func testRunChunksOpsIntoBatches() async throws {
        let fileCount = 12
        for i in 0..<fileCount {
            _ = try makeFile("f\(i).md", contents: "x")
        }

        let fake = FakeHTTPClient()
        await fake.setStubbedResponse(.success(okResponse()))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        // batchSize 5 → 12 files → batches of 5/5/2 = 3 sends
        let coordinator = makeCoordinator(engine: engine, maxBatchSize: 5)

        try await coordinator.run(workspace: snapshot()) { _ in }

        let count = await fake.sendCount
        XCTAssertEqual(count, 3, "12 files / batchSize 5 must produce 3 sends")
    }

    func testRunEmitsProgressAcrossBatches() async throws {
        for i in 0..<6 {
            _ = try makeFile("f\(i).md", contents: "x")
        }
        let fake = FakeHTTPClient()
        await fake.setStubbedResponse(.success(okResponse()))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let coordinator = makeCoordinator(engine: engine, maxBatchSize: 2)

        var phases: [InitialSyncCoordinator.Phase] = []
        var lastSynced: [Int] = []
        try await coordinator.run(workspace: snapshot()) { p in
            phases.append(p.phase)
            lastSynced.append(p.synced)
        }

        // Expected progression: walking → pushing(0/6) → pushing(2/6) → pushing(4/6) → pushing(6/6) → completed
        XCTAssertEqual(phases.first, .walking)
        XCTAssertEqual(phases.last, .completed)
        XCTAssertEqual(lastSynced.last, 6)
    }

    // MARK: - retry

    func testRunRetriesTransportFailureUpToThreeTimes() async throws {
        _ = try makeFile("a.md", contents: "a")

        let fake = FakeHTTPClient()
        await fake.setStubbedResponse(.failure(URLError(.networkConnectionLost)))

        // Flip the stub to success on the first send (will be observed by
        // the second call, which uses the now-updated stub). FakeHTTPClient
        // serializes setStubbedResponse in actor isolation so the swap is
        // safe relative to subsequent send() calls.
        let okStub = okResponse()
        await fake.setOnSend { [fake] in
            Task { await fake.setStubbedResponse(.success(okStub)) }
        }

        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let coordinator = makeCoordinator(engine: engine, maxRetriesPerBatch: 3)

        try await coordinator.run(workspace: snapshot()) { _ in }
        let count = await fake.sendCount
        XCTAssertGreaterThanOrEqual(count, 2, "Transport failure must trigger at least one retry")
    }

    func testRunFailsAfterThreeRetries() async throws {
        _ = try makeFile("a.md", contents: "a")
        let fake = FakeHTTPClient()
        await fake.setStubbedResponse(.failure(URLError(.networkConnectionLost)))

        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let coordinator = makeCoordinator(engine: engine, maxRetriesPerBatch: 3)

        do {
            try await coordinator.run(workspace: snapshot()) { _ in }
            XCTFail("Expected throw after 3 transport failures")
        } catch {
            // Expected
        }
        let count = await fake.sendCount
        XCTAssertEqual(count, 3, "Should have sent exactly maxRetriesPerBatch attempts")
    }

    func testRun401PropagatesUnauthorized() async throws {
        _ = try makeFile("a.md", contents: "a")
        let fake = FakeHTTPClient()
        await fake.setStubbedResponse(.success(HTTPResponse(status: 401, body: Data())))

        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let coordinator = makeCoordinator(engine: engine, maxRetriesPerBatch: 5)

        do {
            try await coordinator.run(workspace: snapshot()) { _ in }
            XCTFail("Expected throw on 401")
        } catch SyncEngine.BatchError.unauthorized {
            // Expected — and there should have been NO retries.
        } catch {
            XCTFail("Expected BatchError.unauthorized, got \(error)")
        }
        let count = await fake.sendCount
        XCTAssertEqual(count, 1, "401 must not retry")
    }

    // MARK: - cancellation

    func testRunIsCancellable() async throws {
        for i in 0..<10 {
            _ = try makeFile("f\(i).md", contents: "x")
        }
        let fake = FakeHTTPClient()
        await fake.setStubbedResponse(.success(okResponse()))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let coordinator = makeCoordinator(engine: engine, maxBatchSize: 1)

        // Cancel immediately, before run starts.
        await coordinator.cancel()

        do {
            try await coordinator.run(workspace: snapshot()) { _ in }
            XCTFail("Expected CancellationError")
        } catch is CancellationError {
            // Expected
        } catch {
            XCTFail("Expected CancellationError, got \(error)")
        }
    }

    // MARK: - empty / idempotency

    func testRunOnEmptyVaultCompletesWithoutSending() async throws {
        let fake = FakeHTTPClient()
        await fake.setStubbedResponse(.success(okResponse()))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let coordinator = makeCoordinator(engine: engine)

        var seen: [InitialSyncCoordinator.Progress] = []
        try await coordinator.run(workspace: snapshot()) { p in seen.append(p) }

        XCTAssertEqual(seen.last?.phase, .completed)
        XCTAssertEqual(seen.last?.total, 0)
        let count = await fake.sendCount
        XCTAssertEqual(count, 0, "Empty vault must produce no HTTP sends")
    }

    func testRunIdempotentOnRepairSamePaths() async throws {
        _ = try makeFile("a.md", contents: "a")
        _ = try makeFile("b.md", contents: "b")
        let fake = FakeHTTPClient()
        await fake.setStubbedResponse(.success(okResponse()))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let coordinator1 = makeCoordinator(engine: engine)
        let coordinator2 = makeCoordinator(engine: engine)

        try await coordinator1.run(workspace: snapshot()) { _ in }
        try await coordinator2.run(workspace: snapshot()) { _ in }

        let count = await fake.sendCount
        XCTAssertEqual(count, 2, "Re-pair re-walks + re-pushes — server idempotent")
    }

    // MARK: - pushInFlight gate

    func testRunPreservesPushInFlightLockDuringRun() async throws {
        for i in 0..<4 {
            _ = try makeFile("f\(i).md", contents: "x")
        }
        let fake = FakeHTTPClient()
        await fake.setStubbedResponse(.success(okResponse()))
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)

        XCTAssertEqual(engine.pushInFlight, 0, "Baseline before run")

        var inFlightDuring: Int32 = 0
        let coordinator = makeCoordinator(engine: engine, maxBatchSize: 2)
        try await coordinator.run(workspace: snapshot()) { p in
            // First progress callback runs at .walking phase, before ops are
            // pushed. By the time the user sees ".pushing", the lock has been
            // acquired.
            if case .pushing = p.phase {
                inFlightDuring = max(inFlightDuring, engine.pushInFlight)
            }
        }

        XCTAssertGreaterThanOrEqual(inFlightDuring, 1,
            "pushInFlight must read >=1 while the coordinator is mid-run")
        XCTAssertEqual(engine.pushInFlight, 0,
            "pushInFlight must decrement back to 0 after run completes")
    }
}
