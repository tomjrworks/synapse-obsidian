import Foundation

/// Owns the security-scoped resource handle for one workspace's vault folder.
/// `init` resolves the bookmark and calls `startAccessingSecurityScopedResource`;
/// `deinit` calls stop. Sandboxed builds MUST hold a live instance for any
/// code path that does file IO on the vault. Non-sandboxed builds still benefit
/// from the same shape (stop is a no-op when start was a no-op).
///
/// Reference type so Workspace can stay a struct: a class-typed `vaultHandle`
/// property ref-counts across struct copies and only deinits when the last
/// copy is dropped (i.e. when the workspace is removed from AppDelegate's
/// `workspaces` array).
final class WorkspaceVaultHandle {
    /// The resolved file URL the bookmark points at. Lives as long as this
    /// handle does; callers may freely reconstruct fresh `URL(fileURLWithPath:)`
    /// values under this path because macOS extends the security-scoped grant
    /// to the underlying filesystem path, not to a specific URL instance.
    let url: URL
    /// Apple's bookmarkDataIsStale flag. A stale bookmark is still usable for
    /// one access; callers should opportunistically re-mint. For 0.2.2 we log
    /// + continue (re-mint is a 0.3.x follow-up).
    let isStale: Bool

    private let didStart: Bool

    /// Resolve a previously-minted security-scoped bookmark. Throws on resolve
    /// failure (caller decides whether to re-prompt or drop the workspace).
    init(bookmark: Data) throws {
        var stale = false
        let resolved = try URL(
            resolvingBookmarkData: bookmark,
            options: [.withSecurityScope],
            relativeTo: nil,
            bookmarkDataIsStale: &stale
        )
        self.url = resolved
        self.isStale = stale
        self.didStart = resolved.startAccessingSecurityScopedResource()
    }

    deinit {
        if didStart { url.stopAccessingSecurityScopedResource() }
    }

    /// Mint a new security-scoped bookmark from a URL the user just picked
    /// via NSOpenPanel. Caller persists the returned `Data` into SettingsStore
    /// and typically constructs a `WorkspaceVaultHandle` from it for the
    /// resulting Workspace.
    ///
    /// The macOS powerbox extends a security-scoped grant on a picked URL for
    /// the lifetime of the helper process — so this call succeeds even when
    /// invoked seconds after the NSOpenPanel callback returns (e.g. inside
    /// `confirmFirstRun` after the user clicks Get Started).
    static func mintBookmark(for pickedURL: URL) throws -> Data {
        try pickedURL.bookmarkData(
            options: [.withSecurityScope],
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        )
    }
}
