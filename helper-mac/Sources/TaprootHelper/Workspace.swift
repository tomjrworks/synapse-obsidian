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
}
