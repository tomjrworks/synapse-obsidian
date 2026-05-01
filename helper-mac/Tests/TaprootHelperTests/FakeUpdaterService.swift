import Foundation
@testable import TaprootHelper

/// In-memory recorder for `UpdaterService`. Drives commit 4+ tests
/// (UpdateCoordinator / AppDelegate ownership) without spinning up
/// a real Sparkle controller.
@MainActor
final class FakeUpdaterService: UpdaterService {
    private(set) var isStarted: Bool = false
    private(set) var startCallCount: Int = 0
    private(set) var checkForUpdatesCallCount: Int = 0
    var automaticallyDownloadsUpdates: Bool = false
    var shouldRelaunchVeto: @MainActor () -> Bool = { false }
    var diagnosticSnapshot: @MainActor () -> String = { "" }

    func start() {
        startCallCount += 1
        isStarted = true
    }

    func checkForUpdates() {
        checkForUpdatesCallCount += 1
    }
}
