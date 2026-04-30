import Foundation

enum ObsidianSyncCheck {
    static func hasConflict(at folder: URL) -> Bool {
        FileManager.default.fileExists(
            atPath: folder.appendingPathComponent(".obsidian/sync.json").path
        )
    }
}
