import Foundation
import Darwin

extension URL {
    /// Returns a file URL with the full path canonicalized — both symlinks
    /// AND firmlinks resolved. This matters because macOS Catalina+ uses
    /// firmlinks for `/var → /private/var` (and similar), and FSEvents reports
    /// event paths via the canonical /private side. `resolvingSymlinksInPath`
    /// alone only follows symlinks, so a workspace folder constructed under
    /// the user's TMPDIR (`/var/folders/...`) would have a non-canonical
    /// `localFolder.path` while FSEvents events arrive canonical — breaking
    /// the prefix check in `SyncEngine.toOp`.
    ///
    /// Falls back to `resolvingSymlinksInPath()` if the path doesn't exist
    /// (realpath returns nil for nonexistent leaves).
    var canonicalPath: URL {
        var buf = [Int8](repeating: 0, count: Int(PATH_MAX))
        guard realpath(self.path, &buf) != nil else {
            return self.resolvingSymlinksInPath()
        }
        return URL(fileURLWithPath: String(cString: buf), isDirectory: self.hasDirectoryPath)
    }
}
