import XCTest
@testable import TaprootHelper

/// S96 — pull-side symlink rejection. A remote upsert whose vault-relative
/// path crosses a symbolic link (at any component or at the leaf) must NOT
/// write to the symlink target. Tests both layers: `SyncEngine.safeJoin`
/// (intermediate-component check) and `AppDelegate.writeFileWithMkdir`
/// (leaf check + defense-in-depth).
final class SymlinkWriteTests: XCTestCase {
    private var vaultRoot: URL!
    private var outside: URL!

    override func setUpWithError() throws {
        // Use a non-firmlinked temp base — /private/tmp is the macOS resolved
        // path; using FileManager.temporaryDirectory works but resolve via
        // realpath via `.resolvingSymlinksInPath`.
        let base = FileManager.default.temporaryDirectory
        vaultRoot = base.appendingPathComponent("taproot-symlink-vault-\(UUID().uuidString)")
            .resolvingSymlinksInPath()
        outside = base.appendingPathComponent("taproot-symlink-outside-\(UUID().uuidString)")
            .resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: vaultRoot, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let vaultRoot, FileManager.default.fileExists(atPath: vaultRoot.path) {
            try? FileManager.default.removeItem(at: vaultRoot)
        }
        if let outside, FileManager.default.fileExists(atPath: outside.path) {
            try? FileManager.default.removeItem(at: outside)
        }
    }

    // MARK: - safeJoin (intermediate-component check)

    func testSafeJoinRefusesIntermediateSymlink() throws {
        // vault/escape -> /tmp/outside (symlink at intermediate component)
        let symlinkAtIntermediate = vaultRoot.appendingPathComponent("escape")
        try FileManager.default.createSymbolicLink(at: symlinkAtIntermediate, withDestinationURL: outside)

        let joined = SyncEngine.safeJoin(folder: vaultRoot, relative: "escape/foo.md")
        XCTAssertNil(joined, "safeJoin must reject paths whose intermediate component is a symlink")
    }

    func testSafeJoinAllowsNormalPath() throws {
        try FileManager.default.createDirectory(at: vaultRoot.appendingPathComponent("notes"), withIntermediateDirectories: true)
        let joined = SyncEngine.safeJoin(folder: vaultRoot, relative: "notes/legit.md")
        XCTAssertNotNil(joined, "Normal nested path must be allowed")
    }

    func testSafeJoinAllowsLeafSymlinkButWriteRefuses() throws {
        // safeJoin doesn't reject when only the LEAF is a symlink (includeTarget=false).
        // The leaf-rejection happens in writeFileWithMkdir.
        let linkAtLeaf = vaultRoot.appendingPathComponent("link.md")
        let outsideTarget = outside.appendingPathComponent("victim.md")
        try Data("real".utf8).write(to: outsideTarget)
        try FileManager.default.createSymbolicLink(at: linkAtLeaf, withDestinationURL: outsideTarget)

        let joined = SyncEngine.safeJoin(folder: vaultRoot, relative: "link.md")
        XCTAssertNotNil(joined, "safeJoin allows leaf-only symlinks; writeFileWithMkdir rejects them")
    }

    // MARK: - writeFileWithMkdir (leaf + intermediate)

    @MainActor
    func testWriteRefusesLeafSymlink() async throws {
        let app = AppDelegate(services: makeServices())
        let outsideTarget = outside.appendingPathComponent("victim.md")
        try Data("real".utf8).write(to: outsideTarget)
        let linkAtLeaf = vaultRoot.appendingPathComponent("link.md")
        try FileManager.default.createSymbolicLink(at: linkAtLeaf, withDestinationURL: outsideTarget)

        await app.writeFileWithMkdir(at: linkAtLeaf, content: "attacker", vaultRoot: vaultRoot)

        let victimAfter = try String(contentsOf: outsideTarget, encoding: .utf8)
        XCTAssertEqual(victimAfter, "real", "Write through a symlink-leaf must NOT mutate the target")
        // The symlink itself should not have been replaced with a regular file either.
        let linkRes = try linkAtLeaf.resourceValues(forKeys: [.isSymbolicLinkKey])
        XCTAssertEqual(linkRes.isSymbolicLink, true)
    }

    @MainActor
    func testWriteRefusesIntermediateSymlink() async throws {
        let app = AppDelegate(services: makeServices())
        let symlinkAtIntermediate = vaultRoot.appendingPathComponent("escape")
        try FileManager.default.createSymbolicLink(at: symlinkAtIntermediate, withDestinationURL: outside)
        let victim = outside.appendingPathComponent("foo.md")

        // Caller already passes the resolved target; writeFileWithMkdir must
        // still refuse because an ancestor is symlinked.
        let unsafeTarget = symlinkAtIntermediate.appendingPathComponent("foo.md")
        await app.writeFileWithMkdir(at: unsafeTarget, content: "attacker", vaultRoot: vaultRoot)

        XCTAssertFalse(
            FileManager.default.fileExists(atPath: victim.path),
            "Write through a symlinked intermediate must NOT create a file at the resolved target"
        )
    }

    @MainActor
    func testWriteAllowsNormalNestedPath() async throws {
        let app = AppDelegate(services: makeServices())
        let target = vaultRoot.appendingPathComponent("notes/legit.md")

        await app.writeFileWithMkdir(at: target, content: "hello", vaultRoot: vaultRoot)

        XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "hello")
    }

    // MARK: - helpers

    private func makeServices() -> Services {
        let keychain = KeychainStore(service: "com.taproot.helper.tests.symlink")
        try? keychain.deleteAllForService()
        return Services(
            keychain: keychain,
            httpClient: FakeHTTPClient(),
            baseURL: URL(string: "http://localhost:0")!,
            now: { Date(timeIntervalSince1970: 0) }
        )
    }
}
