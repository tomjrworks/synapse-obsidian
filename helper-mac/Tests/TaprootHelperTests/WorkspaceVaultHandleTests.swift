import XCTest
@testable import TaprootHelper

final class WorkspaceVaultHandleTests: XCTestCase {
    private var tmpDir: URL!

    override func setUpWithError() throws {
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("taproot-handle-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tmpDir)
    }

    func testMintBookmarkRoundTripsThroughInit() throws {
        let bookmark = try WorkspaceVaultHandle.mintBookmark(for: tmpDir)
        XCTAssertFalse(bookmark.isEmpty, "mintBookmark must produce a non-empty blob")

        let handle = try WorkspaceVaultHandle(bookmark: bookmark)
        // Compare canonical paths — bookmark resolution returns the firmlinked
        // `/private/var/folders/...` form on macOS while NSTemporaryDirectory()
        // hands back the `/var/folders/...` form. realpath() reconciles both.
        XCTAssertEqual(handle.url.canonicalPath.path, tmpDir.canonicalPath.path,
                       "Resolved URL must point at the same filesystem path the bookmark was minted for")
    }

    func testInitThrowsOnMalformedBookmarkData() {
        let garbage = Data(repeating: 0xFF, count: 64)
        XCTAssertThrowsError(try WorkspaceVaultHandle(bookmark: garbage),
                             "Random bytes must fail to resolve as a security-scoped bookmark")
    }

    /// Round-trip mint → resolve → write. Proves the handle keeps the underlying
    /// path writable for its lifetime, which is the whole point of the type.
    func testHandleKeepsPathWritableForItsLifetime() throws {
        let bookmark = try WorkspaceVaultHandle.mintBookmark(for: tmpDir)
        let handle = try WorkspaceVaultHandle(bookmark: bookmark)

        let target = handle.url.appendingPathComponent("probe.md")
        try Data("ok".utf8).write(to: target, options: .atomic)

        XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "ok")
    }
}
