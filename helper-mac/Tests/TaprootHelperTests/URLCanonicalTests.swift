import XCTest
@testable import TaprootHelper

final class URLCanonicalTests: XCTestCase {
    /// `URL.resolvingSymlinksInPath()` does not follow firmlinks. macOS Catalina+
    /// uses a firmlink for `/var → /private/var`, so a workspace folder
    /// constructed under TMPDIR (`/var/folders/...`) would have a non-canonical
    /// `localFolder.path` while FSEvents events arrive canonical — which is the
    /// exact bug T11.3 commit 4 smoke surfaced. Lock the invariant: canonicalPath
    /// MUST resolve `/var/folders/...` to `/private/var/folders/...`.
    func testCanonicalPathResolvesFirmlink() throws {
        // Pick a path that exists (NSTemporaryDirectory is under /var/folders/.../T)
        // so realpath has a target. Any TMPDIR file is fine; we don't need to write.
        let raw = URL(fileURLWithPath: NSTemporaryDirectory())
        let canonical = raw.canonicalPath
        XCTAssertTrue(
            canonical.path.hasPrefix("/private/var/"),
            "Expected canonicalPath to follow /var firmlink, got \(canonical.path)"
        )
    }

    /// realpath returns nil on nonexistent leaves; we fall back to
    /// resolvingSymlinksInPath in that case so the function always returns a URL.
    func testCanonicalPathFallsBackOnNonexistentPath() {
        let bogus = URL(fileURLWithPath: "/this/path/does/not/exist/\(UUID().uuidString)")
        let result = bogus.canonicalPath
        // Result is either resolvingSymlinksInPath's output (no-op for an absolute
        // path with no symlink components) or itself. Either way it's a file URL.
        XCTAssertTrue(result.isFileURL)
        XCTAssertEqual(result.lastPathComponent, bogus.lastPathComponent)
    }

    /// Idempotent: an already-canonical path stays unchanged.
    func testCanonicalPathIsIdempotent() {
        let raw = URL(fileURLWithPath: NSTemporaryDirectory())
        let once = raw.canonicalPath
        let twice = once.canonicalPath
        XCTAssertEqual(once.path, twice.path)
    }
}
