import XCTest
@testable import TaprootHelper

final class ObsidianVaultResolverTests: XCTestCase {
    private var tmpDir: URL!

    override func setUp() {
        super.setUp()
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("obsidian-resolver-tests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tmpDir)
        super.tearDown()
    }

    private func writeConfig(_ json: String) -> URL {
        let url = tmpDir.appendingPathComponent("obsidian.json")
        try? Data(json.utf8).write(to: url)
        return url
    }

    private func makeVaultDir(name: String) -> URL {
        let dir = tmpDir.appendingPathComponent(name)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    // MARK: - tests

    func test_missingFile_returnsEmpty() {
        let configURL = tmpDir.appendingPathComponent("does-not-exist.json")
        XCTAssertEqual(ObsidianVaultResolver.detect(at: configURL), [])
    }

    func test_malformedJSON_returnsEmpty() {
        let configURL = writeConfig("{ this is not valid json")
        XCTAssertEqual(ObsidianVaultResolver.detect(at: configURL), [])
    }

    func test_singleVault_parsesPathAndTimestamp() {
        let vaultDir = makeVaultDir(name: "MyVault")
        let json = """
        {"vaults":{"abc123":{"path":"\(vaultDir.path)","ts":1773697050575,"open":true}}}
        """
        let detected = ObsidianVaultResolver.detect(at: writeConfig(json))
        XCTAssertEqual(detected.count, 1)
        XCTAssertEqual(detected[0].id, "abc123")
        XCTAssertEqual(detected[0].path.path, vaultDir.canonicalPath.path)
        XCTAssertEqual(detected[0].lastOpened.timeIntervalSince1970, 1773697050.575, accuracy: 0.001)
        XCTAssertTrue(detected[0].isOpen)
    }

    func test_multipleVaults_sortsOpenFirstThenByTimestamp() {
        let vA = makeVaultDir(name: "A")
        let vB = makeVaultDir(name: "B")
        let vC = makeVaultDir(name: "C")
        // A: closed, newest. B: closed, oldest. C: open, middle.
        // Expected order: C (open), A (newer closed), B (older closed).
        let json = """
        {"vaults":{
            "id-a":{"path":"\(vA.path)","ts":3000,"open":false},
            "id-b":{"path":"\(vB.path)","ts":1000,"open":false},
            "id-c":{"path":"\(vC.path)","ts":2000,"open":true}
        }}
        """
        let detected = ObsidianVaultResolver.detect(at: writeConfig(json))
        XCTAssertEqual(detected.map(\.id), ["id-c", "id-a", "id-b"])
    }

    func test_orphanVaultPath_skipped() {
        let real = makeVaultDir(name: "real")
        let orphanPath = tmpDir.appendingPathComponent("never-existed").path
        let json = """
        {"vaults":{
            "real":{"path":"\(real.path)","ts":2000,"open":false},
            "orphan":{"path":"\(orphanPath)","ts":3000,"open":true}
        }}
        """
        let detected = ObsidianVaultResolver.detect(at: writeConfig(json))
        XCTAssertEqual(detected.map(\.id), ["real"])
    }

    func test_pathCanonicalized() {
        // /tmp is firmlinked to /private/tmp on macOS — realpath() resolves it.
        let firmlinkedDir = URL(fileURLWithPath: "/tmp")
            .appendingPathComponent("obsidian-resolver-canonical-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: firmlinkedDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: firmlinkedDir) }

        let json = """
        {"vaults":{"x":{"path":"\(firmlinkedDir.path)","ts":1000,"open":false}}}
        """
        let detected = ObsidianVaultResolver.detect(at: writeConfig(json))
        XCTAssertEqual(detected.count, 1)
        XCTAssertTrue(
            detected[0].path.path.hasPrefix("/private/tmp/"),
            "expected canonical /private/tmp prefix, got \(detected[0].path.path)"
        )
    }
}
