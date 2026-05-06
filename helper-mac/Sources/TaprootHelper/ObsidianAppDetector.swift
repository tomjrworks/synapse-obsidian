import AppKit
import Foundation

/// LaunchServices-backed presence check + opener for Obsidian.app.
/// Test seams take closures so XCTest doesn't depend on the real LS database
/// or NSWorkspace's open behavior.
enum ObsidianAppDetector {
    static let bundleID = "md.obsidian"

    /// Returns true if Obsidian.app is registered with LaunchServices for
    /// `md.obsidian`. Handles both `/Applications` and `~/Applications`.
    static func isInstalled(
        lookup: (String) -> URL? = { id in
            NSWorkspace.shared.urlForApplication(withBundleIdentifier: id)
        }
    ) -> Bool {
        lookup(bundleID) != nil
    }

    /// Opens Obsidian via its custom URL scheme (focuses an already-running
    /// instance or launches it). The scheme is registered by Obsidian itself.
    static func openObsidian(
        opener: (URL) -> Void = { NSWorkspace.shared.open($0) }
    ) {
        if let url = URL(string: "obsidian://") {
            opener(url)
        }
    }
}
