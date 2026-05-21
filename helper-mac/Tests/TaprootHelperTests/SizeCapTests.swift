import XCTest
@testable import TaprootHelper

/// S82 — size-cap pre-check in the push read paths (SyncEngine.toOp +
/// InitialSyncCoordinator.walkWorkspace). Files larger than
/// `Constants.MAX_FILE_BYTES` must be skipped and recorded in
/// `LargeFileSkipTracker`.
final class SizeCapTests: XCTestCase {
    private var tmpDir: URL!
    private let baseURL = URL(string: "https://example.test")!

    override func setUpWithError() throws {
        let base = FileManager.default.temporaryDirectory
        tmpDir = base.appendingPathComponent("taproot-sizecap-tests-\(UUID().uuidString)")
            .resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        LargeFileSkipTracker.shared.resetForTesting()
    }

    override func tearDownWithError() throws {
        if let tmpDir, FileManager.default.fileExists(atPath: tmpDir.path) {
            try? FileManager.default.removeItem(at: tmpDir)
        }
        LargeFileSkipTracker.shared.resetForTesting()
    }

    private func makeSnapshot(folder: URL? = nil, id: UUID = UUID()) -> WorkspaceSnapshot {
        WorkspaceSnapshot(id: id, bearer: "test-bearer", localFolder: folder ?? tmpDir)
    }

    /// Write a file with sparse data of `size` bytes. Uses FileHandle seek+write
    /// so we don't allocate 50 MB+ of in-memory buffer in tests.
    private func makeLargeFile(name: String, size: Int64) throws -> URL {
        let url = tmpDir.appendingPathComponent(name)
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(size - 1))
        handle.write(Data([0]))
        return url
    }

    // MARK: - SyncEngine.toOp (push read path)

    func testPushSkipsFileOverMaxBytesAndRecordsInTracker() async throws {
        let workspaceID = UUID()
        let snapshot = makeSnapshot(id: workspaceID)
        let fake = FakeHTTPClient()
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)

        let bigSize = Constants.MAX_FILE_BYTES + 1
        let big = try makeLargeFile(name: "big.bin", size: bigSize)
        let event = FileChangeEvent(path: big, kind: .modified, mtime: nil)

        await engine.push(workspace: snapshot, events: [event])

        let sendCount = await fake.sendCount
        XCTAssertEqual(sendCount, 0, "Push must not send when the only event was a >MAX_FILE_BYTES file")
        XCTAssertEqual(LargeFileSkipTracker.shared.count(for: workspaceID), 1)
        XCTAssertEqual(LargeFileSkipTracker.shared.lastPath(for: workspaceID), "big.bin")
    }

    func testPushPassesFilesUnderMaxBytes() async throws {
        let workspaceID = UUID()
        let snapshot = makeSnapshot(id: workspaceID)
        let fake = FakeHTTPClient()
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)

        let small = tmpDir.appendingPathComponent("small.md")
        try Data("hello".utf8).write(to: small)
        let event = FileChangeEvent(path: small, kind: .created, mtime: nil)

        await engine.push(workspace: snapshot, events: [event])

        let sendCount = await fake.sendCount
        XCTAssertEqual(sendCount, 1, "Small files must still sync")
        XCTAssertEqual(LargeFileSkipTracker.shared.count(for: workspaceID), 0)
    }

    func testPushSkipsLargeButContinuesSmallInSameBatch() async throws {
        let workspaceID = UUID()
        let snapshot = makeSnapshot(id: workspaceID)
        let fake = FakeHTTPClient()
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)

        let big = try makeLargeFile(name: "video.mp4", size: Constants.MAX_FILE_BYTES + 1)
        let small = tmpDir.appendingPathComponent("notes.md")
        try Data("ok".utf8).write(to: small)

        let bigEvent = FileChangeEvent(path: big, kind: .created, mtime: nil)
        let smallEvent = FileChangeEvent(path: small, kind: .created, mtime: nil)

        await engine.push(workspace: snapshot, events: [bigEvent, smallEvent])

        let sendCount = await fake.sendCount
        XCTAssertEqual(sendCount, 1, "One push containing only the small op")
        XCTAssertEqual(LargeFileSkipTracker.shared.count(for: workspaceID), 1)
        XCTAssertEqual(LargeFileSkipTracker.shared.lastPath(for: workspaceID), "video.mp4")
    }

    // MARK: - InitialSyncCoordinator (walk-and-push)

    func testInitialSyncSkipsLargeFilesAndRecords() async throws {
        let workspaceID = UUID()
        let snapshot = makeSnapshot(id: workspaceID)
        let fake = FakeHTTPClient()
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let coordinator = InitialSyncCoordinator(syncEngine: engine, maxBatchSize: 10, maxRetriesPerBatch: 1)

        // One large file + two small files.
        _ = try makeLargeFile(name: "huge.bin", size: Constants.MAX_FILE_BYTES + 1)
        try Data("one".utf8).write(to: tmpDir.appendingPathComponent("a.md"))
        try Data("two".utf8).write(to: tmpDir.appendingPathComponent("b.md"))

        try await coordinator.run(workspace: snapshot, onProgress: { _ in })

        XCTAssertEqual(LargeFileSkipTracker.shared.count(for: workspaceID), 1)
        XCTAssertEqual(LargeFileSkipTracker.shared.lastPath(for: workspaceID), "huge.bin")
    }

    // MARK: - LargeFileSkipTracker semantics

    func testShouldAlertOnceFiresExactlyOncePerWorkspace() {
        let ws = UUID()
        XCTAssertFalse(LargeFileSkipTracker.shared.shouldAlertOnce(for: ws), "No skips → no alert")
        LargeFileSkipTracker.shared.record(workspace: ws, path: "a.bin", size: 999_999_999)
        XCTAssertTrue(LargeFileSkipTracker.shared.shouldAlertOnce(for: ws))
        XCTAssertFalse(LargeFileSkipTracker.shared.shouldAlertOnce(for: ws), "Second call must NOT alert")
        // Another skip after alert shown → still no second alert.
        LargeFileSkipTracker.shared.record(workspace: ws, path: "b.bin", size: 999_999_999)
        XCTAssertFalse(LargeFileSkipTracker.shared.shouldAlertOnce(for: ws))
    }

    func testTrackerIsPerWorkspace() {
        let a = UUID()
        let b = UUID()
        LargeFileSkipTracker.shared.record(workspace: a, path: "x", size: 1)
        XCTAssertEqual(LargeFileSkipTracker.shared.count(for: a), 1)
        XCTAssertEqual(LargeFileSkipTracker.shared.count(for: b), 0)
    }
}
