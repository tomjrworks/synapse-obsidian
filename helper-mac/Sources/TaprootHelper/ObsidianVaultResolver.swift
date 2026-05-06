import Foundation

/// A vault discovered in Obsidian's `obsidian.json` config.
struct DetectedVault: Equatable {
    let id: String           // opaque hex from obsidian.json
    let path: URL            // canonicalized
    let lastOpened: Date     // from `ts` (epoch ms)
    let isOpen: Bool         // from `open`
}

/// Reads `~/Library/Application Support/obsidian/obsidian.json` and returns
/// the vaults Obsidian knows about. Pure (no AppKit, no I/O outside the
/// configured config-file read), so it's trivially unit-testable with
/// fixture JSON written into a temp directory.
enum ObsidianVaultResolver {
    /// Default config path. Test seam takes a `home` override so unit tests
    /// don't touch the real Application Support tree.
    static func defaultConfigURL(home: URL = URL(fileURLWithPath: NSHomeDirectory())) -> URL {
        home
            .appendingPathComponent("Library/Application Support/obsidian/obsidian.json")
    }

    /// Returns detected vaults sorted: open first, then by `lastOpened` desc.
    /// Returns `[]` for missing file, malformed JSON, or no parsable vaults —
    /// these are all valid first-run states (state C in the picker), not errors.
    /// Vaults whose `path` no longer exists on disk are silently skipped
    /// (Obsidian leaves orphans when users delete vaults out-of-band).
    static func detect(
        at configURL: URL = defaultConfigURL(),
        fileManager: FileManager = .default
    ) -> [DetectedVault] {
        guard let data = try? Data(contentsOf: configURL) else {
            return []
        }
        guard let raw = try? JSONDecoder().decode(ConfigShape.self, from: data) else {
            NSLog("[Taproot] ObsidianVaultResolver: malformed obsidian.json at \(configURL.path)")
            return []
        }

        let vaults: [DetectedVault] = raw.vaults.compactMap { (id, entry) -> DetectedVault? in
            var isDir: ObjCBool = false
            guard fileManager.fileExists(atPath: entry.path, isDirectory: &isDir), isDir.boolValue else {
                return nil
            }
            let canonical = URL(fileURLWithPath: entry.path).canonicalPath
            let lastOpened = Date(timeIntervalSince1970: TimeInterval(entry.ts) / 1000.0)
            return DetectedVault(
                id: id,
                path: canonical,
                lastOpened: lastOpened,
                isOpen: entry.open ?? false
            )
        }

        return vaults.sorted { lhs, rhs in
            if lhs.isOpen != rhs.isOpen { return lhs.isOpen && !rhs.isOpen }
            return lhs.lastOpened > rhs.lastOpened
        }
    }

    private struct ConfigShape: Decodable {
        let vaults: [String: VaultEntry]
    }

    private struct VaultEntry: Decodable {
        let path: String
        let ts: Int64
        let open: Bool?
    }
}
