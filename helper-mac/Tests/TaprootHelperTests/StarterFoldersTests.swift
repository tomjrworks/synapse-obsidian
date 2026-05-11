import XCTest
@testable import TaprootHelper

final class StarterFoldersTests: XCTestCase {
    private var tmpDir: URL!

    override func setUp() {
        super.setUp()
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("starter-folders-tests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tmpDir)
        super.tearDown()
    }

    private func dirExists(_ name: String) -> Bool {
        let url = tmpDir.appendingPathComponent(name, isDirectory: true)
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) && isDir.boolValue
    }

    private func makeDir(_ name: String) -> URL {
        let url = tmpDir.appendingPathComponent(name, isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func writeFile(_ name: String, in dir: URL, contents: String = "x") {
        try? Data(contents.utf8).write(to: dir.appendingPathComponent(name))
    }

    // MARK: - tests

    func test_emptyVault_allFiveCreated() {
        let outcomes = StarterFolders.ensure(in: tmpDir)

        XCTAssertEqual(outcomes, [
            .created("daily"),
            .created("decisions"),
            .created("inbox"),
            .created("notes"),
            .created("projects"),
        ])
        for name in StarterFolders.names {
            XCTAssertTrue(dirExists(name), "\(name)/ must exist after ensure")
        }
    }

    func test_inboxAlreadyPopulated_preservesContentsAndCreatesOthers() {
        let inbox = makeDir("inbox")
        writeFile("first-wow.md", in: inbox, contents: "hello")

        let outcomes = StarterFolders.ensure(in: tmpDir)

        XCTAssertEqual(outcomes, [
            .created("daily"),
            .created("decisions"),
            .alreadyExisted("inbox"),
            .created("notes"),
            .created("projects"),
        ])
        // Existing file preserved
        let preserved = inbox.appendingPathComponent("first-wow.md")
        XCTAssertEqual(try? String(contentsOf: preserved), "hello")
        // Other 4 created
        for name in ["daily", "decisions", "notes", "projects"] {
            XCTAssertTrue(dirExists(name))
        }
    }

    func test_allFiveAlreadyPresent_noMutation() throws {
        for name in StarterFolders.names {
            _ = makeDir(name)
        }
        // Capture mtime of `daily/` before to verify no-touch.
        let dailyURL = tmpDir.appendingPathComponent("daily")
        let attrsBefore = try FileManager.default.attributesOfItem(atPath: dailyURL.path)
        let mtimeBefore = attrsBefore[.modificationDate] as? Date

        // Wait long enough that any disk mutation would bump mtime.
        Thread.sleep(forTimeInterval: 1.1)

        let outcomes = StarterFolders.ensure(in: tmpDir)

        XCTAssertEqual(outcomes, [
            .alreadyExisted("daily"),
            .alreadyExisted("decisions"),
            .alreadyExisted("inbox"),
            .alreadyExisted("notes"),
            .alreadyExisted("projects"),
        ])
        let attrsAfter = try FileManager.default.attributesOfItem(atPath: dailyURL.path)
        let mtimeAfter = attrsAfter[.modificationDate] as? Date
        XCTAssertEqual(mtimeBefore, mtimeAfter, "daily/ mtime must be unchanged when already present")
    }

    func test_hiddenFolderAtRoot_untouched() {
        _ = makeDir(".git")
        writeFile("HEAD", in: tmpDir.appendingPathComponent(".git"), contents: "ref: refs/heads/main")

        _ = StarterFolders.ensure(in: tmpDir)

        // `.git/` survives; its file is unmodified
        XCTAssertTrue(dirExists(".git"))
        let head = tmpDir.appendingPathComponent(".git/HEAD")
        XCTAssertEqual(try? String(contentsOf: head), "ref: refs/heads/main")
        // Starters still landed
        for name in StarterFolders.names {
            XCTAssertTrue(dirExists(name))
        }
    }

    func test_fileMasqueradingAsFolder_failsThatOneSiblingsStillCreated() {
        // Drop a regular file named `decisions` at the vault root.
        writeFile("decisions", in: tmpDir, contents: "not a folder")

        let outcomes = StarterFolders.ensure(in: tmpDir)

        XCTAssertEqual(outcomes.count, 5)
        // `decisions` is .failed (collision with regular file).
        if case .failed(let name, _) = outcomes[1] {
            XCTAssertEqual(name, "decisions")
        } else {
            XCTFail("decisions outcome must be .failed when a regular file occupies the name; got \(outcomes[1])")
        }
        // Failure-isolation: the other 4 still created.
        for name in ["daily", "inbox", "notes", "projects"] {
            XCTAssertTrue(dirExists(name), "\(name)/ must still be created when a sibling fails")
        }
        // The regular file itself is untouched.
        let collidingFile = tmpDir.appendingPathComponent("decisions")
        XCTAssertEqual(try? String(contentsOf: collidingFile), "not a folder")
    }

    func test_idempotentAcrossRepeatedCalls() {
        let first = StarterFolders.ensure(in: tmpDir)
        let second = StarterFolders.ensure(in: tmpDir)

        XCTAssertEqual(first, [
            .created("daily"),
            .created("decisions"),
            .created("inbox"),
            .created("notes"),
            .created("projects"),
        ])
        XCTAssertEqual(second, [
            .alreadyExisted("daily"),
            .alreadyExisted("decisions"),
            .alreadyExisted("inbox"),
            .alreadyExisted("notes"),
            .alreadyExisted("projects"),
        ])
    }

    // MARK: - contract anchor

    /// If this fails, you've drifted from STARTER_FOLDERS in
    /// `src/tools/persona-claudemd.ts:164`. Update the server constant in
    /// the same commit.
    func test_namesMatchServerContract() {
        XCTAssertEqual(StarterFolders.names, ["daily", "decisions", "inbox", "notes", "projects"])
    }
}
