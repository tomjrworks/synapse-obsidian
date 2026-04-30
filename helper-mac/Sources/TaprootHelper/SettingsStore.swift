import Foundation

struct SettingsStore {
    private let defaults: UserDefaults

    init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    /// L1 default is `false` (prompt-first install). Persisted so the
    /// preference survives helper relaunch.
    var automaticallyInstallsUpdates: Bool {
        get { defaults.bool(forKey: "taproot.settings.automaticallyInstallsUpdates") }
        set { defaults.set(newValue, forKey: "taproot.settings.automaticallyInstallsUpdates") }
    }

    func isPausedOnLaunch(for id: UUID) -> Bool {
        defaults.bool(forKey: "taproot.pausedOnLaunch.\(id.uuidString)")
    }

    func setPausedOnLaunch(_ paused: Bool, for id: UUID) {
        if paused {
            defaults.set(true, forKey: "taproot.pausedOnLaunch.\(id.uuidString)")
        } else {
            defaults.removeObject(forKey: "taproot.pausedOnLaunch.\(id.uuidString)")
        }
    }

    func clearPausedOnLaunch(for id: UUID) {
        setPausedOnLaunch(false, for: id)
    }

    func workspaceName(for id: UUID) -> String? {
        defaults.string(forKey: "taproot.workspaceName.\(id.uuidString)")
    }

    func setWorkspaceName(_ name: String, for id: UUID) {
        defaults.set(name, forKey: "taproot.workspaceName.\(id.uuidString)")
    }

    func clearWorkspaceName(for id: UUID) {
        defaults.removeObject(forKey: "taproot.workspaceName.\(id.uuidString)")
    }

    func vaultFolder(for id: UUID) -> URL? {
        guard let stored = defaults.string(forKey: "taproot.vaultFolder.\(id.uuidString)") else {
            return nil
        }
        // N10: read via URL(fileURLWithPath:) so a corrupted or injected
        // UserDefaults value (e.g., http://) is coerced into a file URL with
        // a junk path rather than ever returning a non-file URL to the
        // AppDelegate (which would feed it into FSEventStream / NSWorkspace).
        return URL(fileURLWithPath: stored)
    }

    func setVaultFolder(_ url: URL, for id: UUID) {
        // Pair with vaultFolder's URL(fileURLWithPath:) read by storing the
        // raw filesystem path. Round-trip preserves the file:// URL.
        defaults.set(url.path, forKey: "taproot.vaultFolder.\(id.uuidString)")
    }

    func clearVaultFolder(for id: UUID) {
        defaults.removeObject(forKey: "taproot.vaultFolder.\(id.uuidString)")
    }
}
