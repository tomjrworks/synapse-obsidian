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

    /// Opens Obsidian via its custom URL scheme. With `at:` set to a vault
    /// folder, builds `obsidian://open?path=<encoded absolute path>` to open
    /// that folder as a registered vault, skipping Obsidian's first-run
    /// "Open vault as folder" dialog. With `at:` nil, falls back to bare
    /// `obsidian://`, which focuses an already-running instance or launches
    /// the app at its default vault picker.
    static func openObsidian(
        at vaultURL: URL? = nil,
        opener: (URL) -> Void = { NSWorkspace.shared.open($0) }
    ) {
        guard let url = buildOpenURL(at: vaultURL) else { return }
        opener(url)
    }

    /// Builds the obsidian:// URL. Exposed for unit-testable URL construction.
    static func buildOpenURL(at vaultURL: URL?) -> URL? {
        guard let vaultURL else {
            return URL(string: "obsidian://")
        }
        // Obsidian's open?path= takes the absolute filesystem path of a
        // vault folder. Resolve symlinks for stability across moves.
        let resolved = vaultURL.resolvingSymlinksInPath()
        var components = URLComponents()
        components.scheme = "obsidian"
        components.host = "open"
        components.queryItems = [URLQueryItem(name: "path", value: resolved.path)]
        return components.url
    }
}
