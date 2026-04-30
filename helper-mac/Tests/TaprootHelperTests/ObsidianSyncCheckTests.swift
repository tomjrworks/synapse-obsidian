import XCTest
@testable import TaprootHelper

final class ObsidianSyncCheckTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("taproot-obsidian-sync-check-\(UUID().uuidString)")
            .resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    func testHasConflictReturnsTrueWhenSyncJsonExists() throws {
        let obsidian = folder.appendingPathComponent(".obsidian")
        try FileManager.default.createDirectory(at: obsidian, withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: obsidian.appendingPathComponent("sync.json"))

        XCTAssertTrue(ObsidianSyncCheck.hasConflict(at: folder))
    }

    func testHasConflictReturnsFalseWhenAbsent() {
        XCTAssertFalse(ObsidianSyncCheck.hasConflict(at: folder))
    }

    func testHasConflictReturnsFalseWhenObsidianFolderButNoSyncJson() throws {
        let obsidian = folder.appendingPathComponent(".obsidian")
        try FileManager.default.createDirectory(at: obsidian, withIntermediateDirectories: true)

        XCTAssertFalse(ObsidianSyncCheck.hasConflict(at: folder))
    }
}
