import XCTest
@testable import TaprootHelper

/// S83 — files under sensitive dotfolders (.git, .ssh, .aws, etc.) must NOT
/// be enumerated by the initial sync walk, and must NOT be queued for push
/// by the FSEvent watcher.
final class SensitiveFolderTests: XCTestCase {
    private var tmpDir: URL!
    private let baseURL = URL(string: "https://example.test")!

    override func setUpWithError() throws {
        let base = FileManager.default.temporaryDirectory
        tmpDir = base.appendingPathComponent("taproot-sensitive-tests-\(UUID().uuidString)")
            .resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let tmpDir, FileManager.default.fileExists(atPath: tmpDir.path) {
            try? FileManager.default.removeItem(at: tmpDir)
        }
    }

    private func makeSnapshot(folder: URL? = nil) -> WorkspaceSnapshot {
        WorkspaceSnapshot(id: UUID(), bearer: "test-bearer", localFolder: folder ?? tmpDir)
    }

    private func write(_ relPath: String, _ contents: String) throws {
        let url = tmpDir.appendingPathComponent(relPath)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(contents.utf8).write(to: url)
    }

    /// All three sensitive folders must be excluded; only the benign
    /// notes/foo.md file should reach the push body.
    func testInitialSyncSkipsSensitiveDotFolders() async throws {
        try write(".git/HEAD", "ref: refs/heads/main\n")
        try write(".aws/credentials", "[default]\naws_access_key_id=AKIAFAKE\n")
        try write(".ssh/id_rsa", "-----BEGIN PRIVATE KEY-----\n")
        try write(".obsidian/workspace.json", "{}\n") // regression — was already filtered
        try write("notes/foo.md", "hello")

        let snapshot = makeSnapshot()
        let fake = FakeHTTPClient()
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let coordinator = InitialSyncCoordinator(syncEngine: engine, maxBatchSize: 10, maxRetriesPerBatch: 1)

        try await coordinator.run(workspace: snapshot, onProgress: { _ in })

        let lastReq = await fake.lastRequest
        let req = try XCTUnwrap(lastReq)
        struct DecodedOp: Decodable { let kind: String; let path: String }
        struct DecodedBody: Decodable { let ops: [DecodedOp] }
        let decoded = try JSONDecoder().decode(DecodedBody.self, from: req.body)
        let paths = Set(decoded.ops.map(\.path))

        XCTAssertEqual(paths, ["notes/foo.md"], "Only the benign file must be enumerated")
        XCTAssertFalse(paths.contains(".git/HEAD"))
        XCTAssertFalse(paths.contains(".aws/credentials"))
        XCTAssertFalse(paths.contains(".ssh/id_rsa"))
        XCTAssertFalse(paths.contains(".obsidian/workspace.json"))
    }

    /// Every entry in the sensitive list must be recognized — guards against
    /// future drift where someone adds an entry to the set but forgets to
    /// route initial-sync through `WorkspaceWatcher.sensitiveDotFolders`.
    func testEveryListedFolderIsExcluded() async throws {
        for folder in WorkspaceWatcher.sensitiveDotFolders {
            try write("\(folder)/secret.txt", "x")
        }
        try write("legit.md", "yes")

        let snapshot = makeSnapshot()
        let fake = FakeHTTPClient()
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let coordinator = InitialSyncCoordinator(syncEngine: engine, maxBatchSize: 100, maxRetriesPerBatch: 1)

        try await coordinator.run(workspace: snapshot, onProgress: { _ in })

        let lastReq = await fake.lastRequest
        let req = try XCTUnwrap(lastReq)
        struct DecodedOp: Decodable { let kind: String; let path: String }
        struct DecodedBody: Decodable { let ops: [DecodedOp] }
        let decoded = try JSONDecoder().decode(DecodedBody.self, from: req.body)
        let paths = Set(decoded.ops.map(\.path))

        XCTAssertEqual(paths, ["legit.md"])
    }

    /// Regression — a folder named `git` (no dot) must NOT be treated as
    /// sensitive. Substring matching would over-block.
    func testNonDotPrefixedLookalikeNotDropped() async throws {
        try write("git/notes.md", "lookalike")
        try write(".gitsecrets/HEAD", "also-lookalike")
        try write("legit.md", "yes")

        let snapshot = makeSnapshot()
        let fake = FakeHTTPClient()
        let engine = SyncEngine(httpClient: fake, baseURL: baseURL)
        let coordinator = InitialSyncCoordinator(syncEngine: engine, maxBatchSize: 10, maxRetriesPerBatch: 1)

        try await coordinator.run(workspace: snapshot, onProgress: { _ in })

        let lastReq = await fake.lastRequest
        let req = try XCTUnwrap(lastReq)
        struct DecodedOp: Decodable { let kind: String; let path: String }
        struct DecodedBody: Decodable { let ops: [DecodedOp] }
        let decoded = try JSONDecoder().decode(DecodedBody.self, from: req.body)
        let paths = Set(decoded.ops.map(\.path))

        // `git/notes.md` is enumerated (no dot prefix → not hidden).
        // `.gitsecrets/HEAD` is dropped by the `hasPrefix(".")` check on the
        // top-level dotfolder enumeration — that's existing behavior.
        XCTAssertTrue(paths.contains("git/notes.md"), "Plain `git/` folder must NOT be treated as sensitive")
        XCTAssertTrue(paths.contains("legit.md"))
        XCTAssertFalse(paths.contains(".gitsecrets/HEAD"))
    }
}
