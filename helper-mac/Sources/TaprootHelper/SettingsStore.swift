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
}
