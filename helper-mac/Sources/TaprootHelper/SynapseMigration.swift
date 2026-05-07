import Foundation

/// One-shot rename of the legacy `.synapse/` directory to `.taproot/` inside a
/// vault. Carries the helper's per-workspace config across the Synapse →
/// Taproot rebrand without surfacing the old name to users browsing their
/// Obsidian vault root. Idempotent and side-effect-free when neither directory
/// is present, both are present (collision), or only `.taproot/` is present.
///
/// Per F0 plan: must run BEFORE the SyncEngine starts watching the vault —
/// otherwise the FSEvents watcher fires on `.synapse/` events between launch
/// and rename, and the watcher's `.synapse/` events would leak into push.
enum SynapseMigration {
    enum Outcome: Equatable {
        /// `.synapse/` existed and was renamed to `.taproot/`.
        case renamed
        /// Only `.taproot/` exists — already migrated on a prior launch.
        case alreadyMigrated
        /// Both `.synapse/` and `.taproot/` exist. Skipped (manual cleanup
        /// required); this state can occur on multi-device Obsidian Sync
        /// users where one device migrated and another re-created the legacy
        /// directory before sync converged.
        case collision
        /// Neither directory exists. New vaults that were never paired under
        /// the Synapse-era helper.
        case notNeeded
        /// Filesystem operation failed. The migration logs and returns the
        /// error class without throwing, so callers can no-op cleanly and let
        /// the user retry on next launch.
        case failed(String)
    }

    /// Runs the migration once for the given vault root. Caller is expected
    /// to invoke this on the canonicalized vault path (matches what
    /// AppDelegate stores in `Workspace.localFolder`).
    @discardableResult
    static func migrate(
        in vaultURL: URL,
        fileManager: FileManager = .default
    ) -> Outcome {
        let synapseURL = vaultURL.appendingPathComponent(".synapse", isDirectory: true)
        let taprootURL = vaultURL.appendingPathComponent(".taproot", isDirectory: true)

        let synapseExists = isDirectory(at: synapseURL, fileManager: fileManager)
        let taprootExists = isDirectory(at: taprootURL, fileManager: fileManager)

        switch (synapseExists, taprootExists) {
        case (false, false):
            return .notNeeded
        case (false, true):
            return .alreadyMigrated
        case (true, true):
            NSLog("[Taproot] SynapseMigration: both .synapse/ and .taproot/ exist at \(vaultURL.path) — skipping (manual cleanup required)")
            return .collision
        case (true, false):
            do {
                try fileManager.moveItem(at: synapseURL, to: taprootURL)
                NSLog("[Taproot] SynapseMigration: renamed .synapse/ to .taproot/ at \(vaultURL.path)")
                return .renamed
            } catch {
                NSLog("[Taproot] SynapseMigration: rename failed at \(vaultURL.path): \(error.localizedDescription)")
                return .failed(error.localizedDescription)
            }
        }
    }

    private static func isDirectory(at url: URL, fileManager: FileManager) -> Bool {
        var isDir: ObjCBool = false
        guard fileManager.fileExists(atPath: url.path, isDirectory: &isDir) else { return false }
        return isDir.boolValue
    }
}
