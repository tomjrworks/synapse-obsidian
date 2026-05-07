import XCTest
@testable import TaprootHelper

final class SynapseMigrationTests: XCTestCase {
    private var tmpDir: URL!

    override func setUp() {
        super.setUp()
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("synapse-migration-tests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tmpDir)
        super.tearDown()
    }

    private func makeDir(_ name: String) -> URL {
        let url = tmpDir.appendingPathComponent(name, isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func writeFile(_ name: String, in dir: URL, contents: String = "x") {
        try? Data(contents.utf8).write(to: dir.appendingPathComponent(name))
    }

    private func dirExists(_ url: URL) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) && isDir.boolValue
    }

    // MARK: - tests

    func test_synapseExistsTaprootMissing_renamesAndPreservesContents() {
        let synapse = makeDir(".synapse")
        writeFile("config.json", in: synapse, contents: #"{"workspace_id":"abc"}"#)

        let outcome = SynapseMigration.migrate(in: tmpDir)

        XCTAssertEqual(outcome, .renamed)
        XCTAssertFalse(dirExists(tmpDir.appendingPathComponent(".synapse")))
        XCTAssertTrue(dirExists(tmpDir.appendingPathComponent(".taproot")))
        let migratedConfig = tmpDir.appendingPathComponent(".taproot/config.json")
        XCTAssertEqual(try? String(contentsOf: migratedConfig), #"{"workspace_id":"abc"}"#)
    }

    func test_taprootExistsSynapseMissing_isAlreadyMigratedNoop() {
        _ = makeDir(".taproot")

        let outcome = SynapseMigration.migrate(in: tmpDir)

        XCTAssertEqual(outcome, .alreadyMigrated)
        XCTAssertTrue(dirExists(tmpDir.appendingPathComponent(".taproot")))
        XCTAssertFalse(dirExists(tmpDir.appendingPathComponent(".synapse")))
    }

    func test_bothExist_skipsWithCollision() {
        let synapse = makeDir(".synapse")
        let taproot = makeDir(".taproot")
        writeFile("legacy.json", in: synapse)
        writeFile("current.json", in: taproot)

        let outcome = SynapseMigration.migrate(in: tmpDir)

        XCTAssertEqual(outcome, .collision)
        XCTAssertTrue(dirExists(tmpDir.appendingPathComponent(".synapse")))
        XCTAssertTrue(dirExists(tmpDir.appendingPathComponent(".taproot")))
        // Contents on both sides untouched
        XCTAssertNotNil(try? Data(contentsOf: synapse.appendingPathComponent("legacy.json")))
        XCTAssertNotNil(try? Data(contentsOf: taproot.appendingPathComponent("current.json")))
    }

    func test_neitherExists_isNotNeededNoop() {
        let outcome = SynapseMigration.migrate(in: tmpDir)

        XCTAssertEqual(outcome, .notNeeded)
        XCTAssertFalse(dirExists(tmpDir.appendingPathComponent(".synapse")))
        XCTAssertFalse(dirExists(tmpDir.appendingPathComponent(".taproot")))
    }

    func test_idempotentAcrossRepeatedCalls() {
        let synapse = makeDir(".synapse")
        writeFile("config.json", in: synapse)

        XCTAssertEqual(SynapseMigration.migrate(in: tmpDir), .renamed)
        XCTAssertEqual(SynapseMigration.migrate(in: tmpDir), .alreadyMigrated)
        XCTAssertEqual(SynapseMigration.migrate(in: tmpDir), .alreadyMigrated)
    }
}
