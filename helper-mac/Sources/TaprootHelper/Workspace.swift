import Foundation

// Codable is intentionally NOT conformed by Workspace or SyncStatus.
// `Workspace.bearer` belongs in the Keychain and must never be persisted
// to disk via JSONEncoder. When T11.2+ needs disk-backed sync state,
// introduce a separate `WorkspaceMetadata` type with explicitly chosen
// fields (no bearer) and assemble `Workspace` in memory at load time.
enum SyncStatus: Equatable {
    case idle
    case syncing
    case paused
    case error(String)
}

struct Workspace: Identifiable {
    let id: UUID
    var name: String
    var bearer: String
    var localFolder: URL
    var lastSyncAt: Date?
    var pendingCount: Int?   // rows remaining after last pull page; nil = unknown, 0 = caught up
    var syncStatus: SyncStatus
    /// 0.2.2 sandbox: holds the security-scoped resource for this workspace's
    /// vault folder. Class-typed so struct copies share one handle and
    /// `deinit` (which calls `stopAccessingSecurityScopedResource`) fires only
    /// when the LAST copy is dropped — i.e. when the workspace is removed
    /// from AppDelegate's `workspaces` array.
    ///
    /// Optional because legacy unit tests construct Workspaces directly for
    /// menu / poller / heartbeat assertions that don't exercise vault IO.
    /// Production paths (`AppDelegate.confirmFirstRun`,
    /// `AppDelegate.loadWorkspacesFromKeychain`) always set this; an unset
    /// handle in a signed sandboxed bundle would surface as `Operation not
    /// permitted` at the first file IO.
    var vaultHandle: WorkspaceVaultHandle?
}
