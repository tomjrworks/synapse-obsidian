import Foundation

/// S82 — tracks files skipped because they exceed `Constants.MAX_FILE_BYTES`.
/// Written from the push read paths (off-main); read from the menu builder
/// and the post-push tick (on-main). Thread-safe via NSLock so callers can
/// be sync from any context — matches the existing menubar pattern at
/// `syncStatusText` (a sync MainActor function).
final class LargeFileSkipTracker: @unchecked Sendable {
    static let shared = LargeFileSkipTracker()

    private let lock = NSLock()
    private var counts: [UUID: Int] = [:]
    private var lastPaths: [UUID: String] = [:]
    private var alertShown: Set<UUID> = []

    init() {}

    /// Increment the per-workspace skip count and remember the last skipped path.
    func record(workspace: UUID, path: String, size: Int64) {
        lock.lock()
        defer { lock.unlock() }
        counts[workspace, default: 0] += 1
        lastPaths[workspace] = path
        NSLog("[Taproot] size-cap: skipped \(path) (\(size) bytes) in workspace \(workspace.uuidString)")
    }

    func count(for workspace: UUID) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return counts[workspace] ?? 0
    }

    func lastPath(for workspace: UUID) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return lastPaths[workspace]
    }

    /// Returns true exactly once per workspace per process lifetime when a
    /// skip has been recorded. Used to drive a one-shot NSAlert from the
    /// post-push tick — avoids modal-storm when initial sync skips many files.
    func shouldAlertOnce(for workspace: UUID) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard (counts[workspace] ?? 0) > 0 else { return false }
        if alertShown.contains(workspace) { return false }
        alertShown.insert(workspace)
        return true
    }

    /// Test-only. Resets all per-workspace state.
    func resetForTesting() {
        lock.lock()
        defer { lock.unlock() }
        counts.removeAll()
        lastPaths.removeAll()
        alertShown.removeAll()
    }
}
