import Foundation
import CoreServices

struct FileChangeEvent: Equatable {
    enum Kind: Equatable {
        case created
        case modified
        case deleted
    }

    let path: URL
    let kind: Kind
    let mtime: Date?
}

/// Wraps an `FSEventStream` for one workspace's local folder. Coalesces events
/// at the kernel level via `latency`, derives `FileChangeEvent.Kind` from raw
/// flags, and delivers batched events to `onChange` on the main actor.
///
/// The C-style FSEvents callback runs on a private serial DispatchQueue; the
/// hop to main is `DispatchQueue.main.async { MainActor.assumeIsolated { ... } }`.
/// This preserves FIFO ordering with other main-queue work (a `Task { @MainActor }`
/// would not).
final class WorkspaceWatcher {
    private let workspaceID: UUID
    private let folder: URL
    private let latency: TimeInterval
    private let fileManager: FileManager
    private let onChange: @MainActor ([FileChangeEvent]) -> Void
    private let queue: DispatchQueue

    private var stream: FSEventStreamRef?

    init(
        workspaceID: UUID,
        folder: URL,
        latency: TimeInterval = 0.5,
        fileManager: FileManager = .default,
        onChange: @MainActor @escaping ([FileChangeEvent]) -> Void
    ) {
        self.workspaceID = workspaceID
        // Canonicalize once: FSEvents canonicalizes its output (/tmp -> /private/tmp,
        // /var -> /private/var). If we don't normalize here, path comparisons inside
        // event derivation will silently miss matches. `canonicalPath` uses
        // realpath() so firmlinks (/var on macOS Catalina+) resolve too —
        // resolvingSymlinksInPath alone misses those.
        self.folder = URL(fileURLWithPath: folder.path).canonicalPath
        self.latency = latency
        self.fileManager = fileManager
        self.onChange = onChange
        self.queue = DispatchQueue(label: "com.taproot.helper.watcher.\(workspaceID.uuidString)")
    }

    deinit {
        stop()
    }

    /// Idempotent. If the folder is missing or not a directory, logs and no-ops
    /// (T11.7 owns folder creation; the watcher fails open). Re-attach on folder
    /// pick is T11.7's responsibility.
    func start() {
        guard stream == nil else { return }

        var isDir: ObjCBool = false
        guard fileManager.fileExists(atPath: folder.path, isDirectory: &isDir), isDir.boolValue else {
            NSLog("[Taproot] WorkspaceWatcher: folder missing for \(workspaceID.uuidString), watcher idle")
            return
        }

        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil,
            release: nil,
            copyDescription: nil
        )

        let flags: UInt32 = UInt32(
            kFSEventStreamCreateFlagFileEvents
            | kFSEventStreamCreateFlagNoDefer
            | kFSEventStreamCreateFlagUseCFTypes
        )
        guard let stream = FSEventStreamCreate(
            kCFAllocatorDefault,
            Self.callback,
            &context,
            [folder.path] as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            latency,
            flags
        ) else {
            NSLog("[Taproot] WorkspaceWatcher: FSEventStreamCreate failed for \(workspaceID.uuidString)")
            return
        }

        FSEventStreamSetDispatchQueue(stream, queue)
        FSEventStreamStart(stream)
        self.stream = stream
    }

    /// Idempotent.
    func stop() {
        guard let stream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
        self.stream = nil
    }

    // MARK: - Callback bridge

    private static let callback: FSEventStreamCallback = { _, info, count, paths, flags, _ in
        guard let info else { return }
        let watcher = Unmanaged<WorkspaceWatcher>.fromOpaque(info).takeUnretainedValue()
        // We set kFSEventStreamCreateFlagUseCFTypes, so `paths` is a CFArray of CFStrings.
        let cfArray = Unmanaged<CFArray>.fromOpaque(paths).takeUnretainedValue()
        let pathArray = (cfArray as NSArray) as? [String] ?? []

        var events: [FileChangeEvent] = []
        events.reserveCapacity(count)

        for i in 0..<count {
            guard i < pathArray.count else { continue }
            let pathStr = pathArray[i]
            let flag = flags[i]

            // Sentinel flags: log and continue without emitting an event.
            if flag & UInt32(kFSEventStreamEventFlagMustScanSubDirs) != 0
                || flag & UInt32(kFSEventStreamEventFlagUserDropped) != 0
                || flag & UInt32(kFSEventStreamEventFlagKernelDropped) != 0 {
                NSLog("[Taproot] WorkspaceWatcher: drop/scan sentinel for \(watcher.workspaceID.uuidString) at \(pathStr) — T11.3 reconciliation will catch up")
            }
            if flag & UInt32(kFSEventStreamEventFlagHistoryDone) != 0 {
                continue
            }

            let url = URL(fileURLWithPath: pathStr).canonicalPath

            // Drop the watched folder root itself.
            if url.path == watcher.folder.path { continue }
            // Drop directories and symlinks (T11.2 = files only).
            if flag & UInt32(kFSEventStreamEventFlagItemIsDir) != 0 { continue }
            if flag & UInt32(kFSEventStreamEventFlagItemIsSymlink) != 0 { continue }
            // Drop hidden files (catches .DS_Store and friends).
            if url.lastPathComponent.hasPrefix(".") { continue }
            // Drop anything inside .obsidian/ (Obsidian configs, plugins,
            // workspace state). Path-component compare — not substring — so
            // a sibling folder named "my.obsidian-notes" is NOT dropped.
            if url.pathComponents.contains(".obsidian") { continue }

            if let event = watcher.derive(path: url, flag: flag) {
                events.append(event)
            }
        }

        guard !events.isEmpty else { return }
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                watcher.onChange(events)
            }
        }
    }

    // MARK: - Kind derivation

    private func derive(path: URL, flag: UInt32) -> FileChangeEvent? {
        let exists = fileManager.fileExists(atPath: path.path)
        let removed = flag & UInt32(kFSEventStreamEventFlagItemRemoved) != 0
        let renamed = flag & UInt32(kFSEventStreamEventFlagItemRenamed) != 0
        let created = flag & UInt32(kFSEventStreamEventFlagItemCreated) != 0
        let modified = flag & UInt32(kFSEventStreamEventFlagItemModified) != 0

        if removed && !exists {
            return FileChangeEvent(path: path, kind: .deleted, mtime: nil)
        }
        if renamed {
            return FileChangeEvent(
                path: path,
                kind: exists ? .created : .deleted,
                mtime: exists ? mtime(of: path) : nil
            )
        }
        if created && !modified {
            return FileChangeEvent(path: path, kind: .created, mtime: mtime(of: path))
        }
        // Default: covers `Modified` alone, `Created+Modified`, `InodeMetaMod`, etc.
        return FileChangeEvent(
            path: path,
            kind: exists ? .modified : .deleted,
            mtime: exists ? mtime(of: path) : nil
        )
    }

    private func mtime(of url: URL) -> Date? {
        let attrs = try? fileManager.attributesOfItem(atPath: url.path)
        return attrs?[.modificationDate] as? Date
    }
}
