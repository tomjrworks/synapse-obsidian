import Foundation

/// 1s, 2s, 4s — exponential, attempts are 1-indexed. Lives at file scope
/// because Swift forbids referencing `Self` in default-argument expressions
/// (covariant generic restriction).
let defaultInitialSyncBackoff: @Sendable (Int) -> UInt64 = { attempt in
    let safeAttempt = max(1, attempt)
    let seconds = UInt64(1) << UInt64(safeAttempt - 1)
    return seconds * 1_000_000_000
}

/// Walks a workspace's local folder once, batches each existing file as an
/// upsert PushOp, and pushes those batches through `SyncEngine.pushBatch`.
///
/// Phase 1 (0.1.5) addresses the beta-blocker: `WorkspaceWatcher` is event-only
/// and starts FSEvents at `kFSEventStreamEventIdSinceNow`, so files already on
/// disk at pair time never reach the cloud mirror until the user edits them.
/// This coordinator runs to completion BEFORE `WorkspaceWatcher` starts — see
/// `AppDelegate.confirmFirstRun`. The watcher-after-walk ordering eliminates
/// the modify-during-walk race where FSEvents and the walker could push
/// stale-vs-fresh content for the same path.
///
/// Concurrency:
/// - `actor` isolation guards mutable state (cancel flag).
/// - File I/O runs synchronously inside actor methods; the walk + read happens
///   off the main thread because the actor is non-MainActor.
/// - Progress callbacks hop to `@MainActor` for UI updates.
/// - `pushInFlightLock` on `SyncEngine` is incremented ONCE at run start and
///   decremented ONCE on completion. Sparkle's relaunch-postpone hook polls
///   `syncEngine.pushInFlight` synchronously every 2s during a pending update;
///   per-batch toggling would race that gate.
actor InitialSyncCoordinator {

    enum Phase: Sendable, Equatable {
        case walking
        case pushing
        case completed
        case failed(String)
    }

    struct Progress: Sendable, Equatable {
        let synced: Int
        let total: Int
        let phase: Phase
    }

    private let syncEngine: SyncEngine
    private let fileManager: FileManager
    private let maxBatchSize: Int
    private let maxRetriesPerBatch: Int
    private let backoffNanoseconds: @Sendable (Int) -> UInt64

    private var cancelled: Bool = false

    init(
        syncEngine: SyncEngine,
        fileManager: FileManager = .default,
        maxBatchSize: Int = 100,
        maxRetriesPerBatch: Int = 3,
        backoffNanoseconds: @Sendable @escaping (Int) -> UInt64 = defaultInitialSyncBackoff
    ) {
        self.syncEngine = syncEngine
        self.fileManager = fileManager
        self.maxBatchSize = maxBatchSize
        self.maxRetriesPerBatch = maxRetriesPerBatch
        self.backoffNanoseconds = backoffNanoseconds
    }

    func cancel() {
        cancelled = true
    }

    /// Walk + push all existing files in `workspace.localFolder`. Calls
    /// `onProgress` on `@MainActor` at each phase transition and after every
    /// successful batch. Returns when all batches succeed; throws on permanent
    /// failure (after `maxRetriesPerBatch` transport retries) or 401.
    func run(
        workspace: WorkspaceSnapshot,
        onProgress: @MainActor @escaping (Progress) -> Void
    ) async throws {
        syncEngine.incrementPushInFlight()
        defer { syncEngine.decrementPushInFlight() }

        await emit(.init(synced: 0, total: 0, phase: .walking), to: onProgress)

        if cancelled { throw CancellationError() }
        try Task.checkCancellation()

        let ops = walkWorkspace(folder: workspace.localFolder)
        let total = ops.count

        if cancelled { throw CancellationError() }
        try Task.checkCancellation()

        if ops.isEmpty {
            await emit(.init(synced: 0, total: 0, phase: .completed), to: onProgress)
            return
        }

        await emit(.init(synced: 0, total: total, phase: .pushing), to: onProgress)

        var synced = 0
        var batchSize = maxBatchSize
        var index = 0

        while index < ops.count {
            if cancelled { throw CancellationError() }
            try Task.checkCancellation()

            let end = min(index + batchSize, ops.count)
            let batch = Array(ops[index..<end])

            do {
                _ = try await pushWithRetry(workspace: workspace, ops: batch)
                synced += batch.count
                index = end
                await emit(.init(synced: synced, total: total, phase: .pushing), to: onProgress)
            } catch SyncEngine.BatchError.payloadTooLarge {
                if batchSize <= 1 {
                    NSLog("[Taproot] InitialSync: 413 at batchSize=1 — giving up")
                    throw SyncEngine.BatchError.payloadTooLarge
                }
                batchSize = max(1, batchSize / 2)
                NSLog("[Taproot] InitialSync: 413 — halving batchSize to \(batchSize) and retrying")
            }
        }

        await emit(.init(synced: synced, total: total, phase: .completed), to: onProgress)
    }

    // MARK: - private

    private func emit(
        _ progress: Progress,
        to onProgress: @MainActor @escaping (Progress) -> Void
    ) async {
        await MainActor.run { onProgress(progress) }
    }

    /// Retry transport failures up to `maxRetriesPerBatch`. 401 / 413 / encoding
    /// errors propagate immediately (caller decides; 413 halves batch size).
    private func pushWithRetry(
        workspace: WorkspaceSnapshot,
        ops: [PushOp]
    ) async throws -> [PushResultEntry] {
        var attempt = 0
        while true {
            do {
                return try await syncEngine.pushBatch(workspace: workspace, ops: ops)
            } catch SyncEngine.BatchError.unauthorized {
                throw SyncEngine.BatchError.unauthorized
            } catch SyncEngine.BatchError.payloadTooLarge {
                throw SyncEngine.BatchError.payloadTooLarge
            } catch SyncEngine.BatchError.encodingFailed(let inner) {
                NSLog("[Taproot] InitialSync: encode failed: \(inner) — not retrying")
                throw SyncEngine.BatchError.encodingFailed(inner)
            } catch {
                attempt += 1
                if attempt >= maxRetriesPerBatch {
                    NSLog("[Taproot] InitialSync: batch failed after \(maxRetriesPerBatch) attempts: \(error)")
                    throw error
                }
                let nanos = backoffNanoseconds(attempt)
                NSLog("[Taproot] InitialSync: batch attempt \(attempt) failed, sleeping \(nanos / 1_000_000_000)s: \(error)")
                if nanos > 0 {
                    try await Task.sleep(nanoseconds: nanos)
                }
                if cancelled { throw CancellationError() }
                try Task.checkCancellation()
            }
        }
    }

    /// Walk `folder` and produce upsert ops for every regular non-hidden file.
    /// Filter mirrors `WorkspaceWatcher.swift:140-149` so files queued here are
    /// the same set the watcher would push on edit (no drift).
    private func walkWorkspace(folder: URL) -> [PushOp] {
        var ops: [PushOp] = []

        // Canonicalize once: FileManager.enumerator vends canonical paths
        // (`/private/var/...`) on macOS, but a caller-supplied folder URL may
        // still contain the firmlinked `/var/...` form. Without this normalize
        // step, the prefix check below rejects every enumerated child. Mirrors
        // the WorkspaceWatcher canonicalization (WorkspaceWatcher.swift:42-47).
        let folder = URL(fileURLWithPath: folder.path).canonicalPath

        let resourceKeys: [URLResourceKey] = [
            .isRegularFileKey,
            .isHiddenKey,
            .isSymbolicLinkKey,
            .contentModificationDateKey,
        ]

        guard let enumerator = fileManager.enumerator(
            at: folder,
            includingPropertiesForKeys: resourceKeys,
            options: [],
            errorHandler: { url, error in
                NSLog("[Taproot] InitialSync: enumerator error at \(url.path): \(error)")
                return true
            }
        ) else {
            NSLog("[Taproot] InitialSync: enumerator init failed for \(folder.path)")
            return []
        }

        let folderPath = folder.path.hasSuffix("/") ? folder.path : folder.path + "/"
        let isoFormatter = ISO8601DateFormatter()

        for case let url as URL in enumerator {
            let lastComponent = url.lastPathComponent

            // Hidden files / dot-folders (catches .DS_Store, .git, etc.).
            if lastComponent.hasPrefix(".") {
                if let resource = try? url.resourceValues(forKeys: [.isDirectoryKey]),
                   resource.isDirectory == true {
                    enumerator.skipDescendants()
                }
                continue
            }
            // Obsidian metadata folder.
            if url.pathComponents.contains(".obsidian") {
                continue
            }

            let resource: URLResourceValues
            do {
                resource = try url.resourceValues(forKeys: Set(resourceKeys))
            } catch {
                NSLog("[Taproot] InitialSync: resource lookup failed for \(url.path): \(error)")
                continue
            }

            if resource.isSymbolicLink == true { continue }
            guard resource.isRegularFile == true else { continue }
            if url.path == folder.path { continue }

            // Relativize against the workspace root.
            let absPath = url.path
            guard absPath.hasPrefix(folderPath) else {
                NSLog("[Taproot] InitialSync: skipping outside-root path \(absPath)")
                continue
            }
            let relative = String(absPath.dropFirst(folderPath.count))
            if relative.isEmpty { continue }

            // Defense in depth — refuse anything that would escape after relativize.
            guard SyncEngine.safeJoin(folder: folder, relative: relative) != nil else {
                NSLog("[Taproot] InitialSync: refusing path-escape: \(relative)")
                continue
            }

            // Read content; skip binary / unreadable files.
            guard let data = try? Data(contentsOf: url) else {
                NSLog("[Taproot] InitialSync: read failed for \(relative); skipping")
                continue
            }
            guard let content = String(data: data, encoding: .utf8) else {
                NSLog("[Taproot] InitialSync: non-UTF8 file \(relative); skipping")
                continue
            }

            let mtimeStr = resource.contentModificationDate.map { isoFormatter.string(from: $0) }

            ops.append(PushOp(
                kind: .upsert,
                path: relative,
                content: content,
                mtime: mtimeStr
            ))
        }

        return ops
    }
}
