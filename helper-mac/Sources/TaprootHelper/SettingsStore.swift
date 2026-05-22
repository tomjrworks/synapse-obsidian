import Foundation

struct SettingsStore {
    private let defaults: UserDefaults

    init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    /// Mirrors Sparkle's `automaticallyDownloadsUpdates`. L1 default is
    /// `false` (Sparkle's standard UI behavior — user sees the Install
    /// prompt before download). Persisted so the preference survives
    /// helper relaunch.
    var automaticallyDownloadsUpdates: Bool {
        get { defaults.bool(forKey: "taproot.settings.automaticallyDownloadsUpdates") }
        set { defaults.set(newValue, forKey: "taproot.settings.automaticallyDownloadsUpdates") }
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

    private func bookmarkKey(_ id: UUID) -> String {
        "taproot.vaultBookmark.\(id.uuidString)"
    }

    private func legacyVaultFolderKey(_ id: UUID) -> String {
        "taproot.vaultFolder.\(id.uuidString)"
    }

    /// Returns the persisted security-scoped bookmark blob for this workspace,
    /// or nil if never set. Pre-0.2.2 prefs that contain only the legacy
    /// `taproot.vaultFolder.<uuid>` path string return nil here — see
    /// `consumeLegacyVaultFolderPath`.
    func vaultBookmark(for id: UUID) -> Data? {
        defaults.data(forKey: bookmarkKey(id))
    }

    func setVaultBookmark(_ data: Data, for id: UUID) {
        defaults.set(data, forKey: bookmarkKey(id))
        // Best-effort cleanup of the legacy path-string key on every bookmark
        // write so a future helper version that drops the legacy reader entirely
        // never sees stale data.
        defaults.removeObject(forKey: legacyVaultFolderKey(id))
    }

    func clearVaultBookmark(for id: UUID) {
        defaults.removeObject(forKey: bookmarkKey(id))
        defaults.removeObject(forKey: legacyVaultFolderKey(id))
    }

    /// Read-and-clear the legacy pre-0.2.2 path-string vault folder. Returns
    /// the stored path if present, removing the key as a side effect. Used by
    /// the rehydration path at launch to detect workspaces that paired before
    /// security-scoped bookmark persistence shipped, so AppDelegate can drop
    /// the in-memory workspace and surface a re-pair prompt.
    func consumeLegacyVaultFolderPath(for id: UUID) -> String? {
        let key = legacyVaultFolderKey(id)
        let value = defaults.string(forKey: key)
        if value != nil {
            defaults.removeObject(forKey: key)
        }
        return value
    }
}
