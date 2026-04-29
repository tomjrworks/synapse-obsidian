import Foundation

enum SyncStatus: Codable, Equatable {
    case idle
    case syncing
    case paused
    case error(String)
}

struct Workspace: Identifiable, Codable {
    let id: UUID
    var name: String
    var bearer: String
    var localFolder: URL
    var lastSyncAt: Date?
    var syncStatus: SyncStatus
}
