import Foundation

struct SettingsStore {
    private let defaults: UserDefaults

    init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    var notificationsEnabled: Bool {
        get { defaults.bool(forKey: "taproot.settings.notificationsEnabled") }
        set { defaults.set(newValue, forKey: "taproot.settings.notificationsEnabled") }
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
        return URL(string: stored)
    }

    func setVaultFolder(_ url: URL, for id: UUID) {
        defaults.set(url.absoluteString, forKey: "taproot.vaultFolder.\(id.uuidString)")
    }

    func clearVaultFolder(for id: UUID) {
        defaults.removeObject(forKey: "taproot.vaultFolder.\(id.uuidString)")
    }
}
