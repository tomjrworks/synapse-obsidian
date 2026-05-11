import Foundation

/// Pre-creates the 5 starter folders at the vault root on first pairing so
/// that disk reality matches the CLAUDE.md filing decision tree from t=0
/// onward. Without this, a fresh vault has zero folders, the server-rendered
/// CLAUDE.md emits the L7 starter scaffold, but the AI client following the
/// filing tree tries to save into folders that don't exist on disk — either
/// failing or silently auto-creating, in which case the next CLAUDE.md
/// render (folder-scan != 0) drops 4 of the 5 starters and the filing tree
/// goes out of sync with disk.
///
/// Idempotent and per-folder failure-isolated: a single folder collision
/// (e.g. user has a file named `decisions` at the vault root) does NOT abort
/// the siblings.
enum StarterFolders {
    /// Contract: matches `STARTER_FOLDERS` in
    /// `src/tools/persona-claudemd.ts:164` (order + names). If you change
    /// this list, change the server constant in the same commit.
    static let names = ["daily", "decisions", "inbox", "notes", "projects"]

    enum Outcome: Equatable {
        case created(String)
        case alreadyExisted(String)
        case failed(String, String)  // (folder name, error description)
    }

    /// Idempotently creates each starter folder at the vault root. Per-folder
    /// errors are logged and recorded in the returned outcomes, but do NOT
    /// abort the remaining siblings.
    @discardableResult
    static func ensure(
        in vaultURL: URL,
        fileManager: FileManager = .default
    ) -> [Outcome] {
        var outcomes: [Outcome] = []
        for name in names {
            let url = vaultURL.appendingPathComponent(name, isDirectory: true)
            var isDir: ObjCBool = false
            if fileManager.fileExists(atPath: url.path, isDirectory: &isDir),
               isDir.boolValue {
                outcomes.append(.alreadyExisted(name))
                continue
            }
            do {
                try fileManager.createDirectory(
                    at: url,
                    withIntermediateDirectories: true
                )
                NSLog("[Taproot] starter-folder: created \(name)/ at \(vaultURL.path)")
                outcomes.append(.created(name))
            } catch {
                NSLog("[Taproot] starter-folder: failed to create \(name)/ at \(vaultURL.path): \(error.localizedDescription)")
                outcomes.append(.failed(name, error.localizedDescription))
            }
        }
        return outcomes
    }
}
