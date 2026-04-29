import AppKit

/// All AppDelegate methods and property mutations must run on the main thread.
/// NSApplicationDelegate callbacks, NSStatusItem, and AppKit menu state all
/// require main-thread isolation. `@MainActor` enforces this at compile time
/// — T11.2 file watcher callbacks (FSEventStream, background queue) MUST
/// dispatch to main before touching `workspaces` or other state here.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    /// Internal access so tests can seed and inspect.
    var workspaces: [Workspace] = []
    /// Internal access so tests can verify watcher lifecycle.
    var watchers: [UUID: WorkspaceWatcher] = [:]
    /// Internal access so tests can verify poller lifecycle.
    var pullPollers: [UUID: Task<Void, Never>] = [:]
    /// Internal access so tests can verify cursor advance + clear.
    var pullCursors: [UUID: PullCursor] = [:]
    private let services: Services
    /// Internal access so tests can drive push-side wire-in checks.
    let syncEngine: SyncEngine

    /// Polling interval in ms. `TAPROOT_PULL_INTERVAL_MS` env-var seam matches
    /// the existing `TAPROOT_BASE_URL` / `TAPROOT_LOCAL_FOLDER_BASE` test
    /// pattern. Read at instance construction; tests set the env before init.
    private let pullIntervalMs: UInt64 = {
        if let raw = ProcessInfo.processInfo.environment["TAPROOT_PULL_INTERVAL_MS"],
           let n = UInt64(raw), n > 0 {
            return n
        }
        return 30_000
    }()

    /// D5 cap: max pages drained per tick. Bounds the watcher-pause window to
    /// roughly 5000 files / 10s on initial pull of a large workspace.
    static let maxDrainPagesPerTick = 10

    /// `nonisolated` so `main.swift` (top-level synchronous code, no actor)
    /// and tests can construct AppDelegate without `await`. The init only stores
    /// a value-type ref; mutating methods + property access stay `@MainActor`.
    nonisolated init(services: Services = .production()) {
        self.services = services
        self.syncEngine = SyncEngine(httpClient: services.httpClient, baseURL: services.baseURL)
        super.init()
    }

    func applicationWillFinishLaunching(_: Notification) {
        // Register the AppleEvent URL handler before AppKit posts kAEGetURL.
        // If the helper is launched *via* a taproot:// URL, the event arrives
        // between will- and didFinishLaunching; registering in did- would miss it.
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleGetURLEvent(_:withReplyEvent:)),
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )
    }

    func applicationDidFinishLaunching(_: Notification) {
        // Required for menubar-only behavior when launched as an unbundled SwiftPM
        // binary. LSUIElement in Info.plist only takes effect inside a .app bundle;
        // setActivationPolicy(.accessory) is the runtime equivalent.
        NSApp.setActivationPolicy(.accessory)

        loadWorkspacesFromKeychain()
        // Wire SyncEngine's 401 callback to AppDelegate.signOut. `[weak self]`
        // because the engine outlives a notional teardown, and we don't want
        // its callback to keep AppDelegate alive past app shutdown.
        Task { [weak self] in
            await self?.syncEngine.setOnUnauthorized { [weak self] id in
                self?.signOut(workspaceID: id)
            }
        }
        startAllWatchers()
        startAllPullPollers()

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            button.image = NSImage(systemSymbolName: "leaf.fill", accessibilityDescription: "Taproot")
        }

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Taproot Helper (placeholder)", action: nil, keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))
        item.menu = menu

        statusItem = item
    }

    func loadWorkspacesFromKeychain() {
        do {
            let entries = try services.keychain.retrieveAll()
            workspaces = entries.map { (id, bearer) in
                Workspace(
                    id: id,
                    name: "Workspace",
                    bearer: bearer,
                    // §5: canonicalize so prefix-comparison in SyncEngine.toOp
                    // matches WorkspaceWatcher's already-canonicalized event paths.
                    // `canonicalPath` uses realpath() so firmlinks (`/var` →
                    // `/private/var` on macOS Catalina+) resolve, which
                    // `resolvingSymlinksInPath()` alone does not.
                    localFolder: defaultLocalFolder(for: id).canonicalPath,
                    lastSyncAt: nil,
                    syncStatus: .idle
                )
            }
            // Seed cursors from UserDefaults so the first pull tick after
            // launch resumes from where the previous session left off (or
            // initial-pull if never persisted).
            for ws in workspaces {
                if let c = loadCursor(for: ws.id) {
                    pullCursors[ws.id] = c
                }
            }
            NSLog("[Taproot] Loaded \(workspaces.count) workspace(s) from Keychain")
        } catch {
            NSLog("[Taproot] Keychain retrieveAll failed: \(error)")
            workspaces = []
        }
    }

    private func defaultLocalFolder(for workspaceID: UUID) -> URL {
        // `TAPROOT_LOCAL_FOLDER_BASE` is a smoke-test seam (T11.3 §7); inert in
        // production unless set, in which case the base directory is rooted
        // wherever the smoke driver chose. Always logged at launch via the
        // surrounding callers' workspace-load NSLog.
        let base = ProcessInfo.processInfo.environment["TAPROOT_LOCAL_FOLDER_BASE"]
            .flatMap { URL(fileURLWithPath: $0) }
            ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Documents")
        return base.appendingPathComponent("Taproot/\(workspaceID.uuidString)")
    }

    @objc func handleGetURLEvent(_ event: NSAppleEventDescriptor, withReplyEvent _: NSAppleEventDescriptor) {
        guard let urlString = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue,
              let url = URL(string: urlString) else {
            NSLog("[Taproot] handleGetURLEvent: missing or invalid URL")
            return
        }
        handleAuthURL(url)
    }

    /// Parses an auth deep link, persists the bearer to Keychain, and upserts the
    /// in-memory workspace. Extracted from `handleGetURLEvent` so tests can drive
    /// it directly without synthesizing AppleEvents.
    func handleAuthURL(_ url: URL) {
        do {
            let link = try DeepLinkParser.parseAuth(url)
            try services.keychain.store(workspaceID: link.workspaceID, bearer: link.bearer)
            if let idx = workspaces.firstIndex(where: { $0.id == link.workspaceID }) {
                workspaces[idx].bearer = link.bearer
            } else {
                let newWorkspace = Workspace(
                    id: link.workspaceID,
                    name: "Workspace",
                    bearer: link.bearer,
                    // §5: canonicalize (see loadWorkspacesFromKeychain).
                    localFolder: defaultLocalFolder(for: link.workspaceID).canonicalPath,
                    lastSyncAt: nil,
                    syncStatus: .idle
                )
                workspaces.append(newWorkspace)
                startWatcher(for: newWorkspace)
                startPullPoller(for: newWorkspace)
            }
            NSLog("[Taproot] Stored bearer for workspace \(link.workspaceID.uuidString)")
        } catch {
            NSLog("[Taproot] Deep-link handling failed: \(error)")
        }
    }

    /// Stub for T11.5 menubar UI. Removes the Keychain entry + in-memory record.
    /// Stop the poller AND the watcher BEFORE the do-block so a Keychain throw
    /// can't leave a running poller/watcher attached to a workspace we're
    /// trying to delete. Cancel poller first so an in-flight tick can't race
    /// a final pull through a stopped watcher.
    func signOut(workspaceID: UUID) {
        stopPullPoller(for: workspaceID)
        watchers[workspaceID]?.stop()
        watchers.removeValue(forKey: workspaceID)
        do {
            try services.keychain.delete(workspaceID: workspaceID)
            workspaces.removeAll { $0.id == workspaceID }
            pullCursors.removeValue(forKey: workspaceID)
            clearCursor(for: workspaceID)
            NSLog("[Taproot] Signed out workspace \(workspaceID.uuidString)")
        } catch {
            NSLog("[Taproot] signOut failed: \(error)")
        }
    }

    // MARK: - Watcher lifecycle

    /// Idempotent. Constructs a WorkspaceWatcher for the workspace and starts it.
    /// Early-returns if a watcher already exists for the workspace ID.
    func startWatcher(for workspace: Workspace) {
        guard watchers[workspace.id] == nil else { return }
        let id = workspace.id
        let watcher = WorkspaceWatcher(
            workspaceID: id,
            folder: workspace.localFolder
        ) { [weak self] events in
            self?.handleFileChanges(workspaceID: id, events: events)
        }
        watcher.start()
        watchers[id] = watcher
    }

    /// Iterates `workspaces` and starts a watcher per workspace. Extracted from
    /// `applicationDidFinishLaunching` as a testable seam (tests can populate
    /// workspaces and call this without triggering full app launch / NSStatusItem).
    func startAllWatchers() {
        workspaces.forEach { startWatcher(for: $0) }
    }

    /// Routes batched file change events to `SyncEngine.push`. Internal access
    /// so tests can drive the wire-in directly without spinning up a real watcher.
    ///
    /// In-flight push during signOut is NOT cancelled. Idempotency analysis lives
    /// in the T11.3 plan §4: the 401-fired re-entrant `signOut` is safe because
    /// `KeychainStore.delete` tolerates `errSecItemNotFound`, watchers dict lookup
    /// is optional, and `workspaces.removeAll` no-ops on empty match.
    func handleFileChanges(workspaceID: UUID, events: [FileChangeEvent]) {
        NSLog("[Taproot] Watcher fired for \(workspaceID.uuidString): \(events.count) event(s)")
        guard let workspace = workspaces.first(where: { $0.id == workspaceID }) else {
            NSLog("[Taproot] Dropping events for unknown workspace \(workspaceID.uuidString)")
            return
        }
        let snapshot = WorkspaceSnapshot(
            id: workspace.id,
            bearer: workspace.bearer,
            localFolder: workspace.localFolder
        )
        Task { [syncEngine] in
            await syncEngine.push(workspace: snapshot, events: events)
        }
    }

    // MARK: - Pull poller lifecycle (T11.4)

    /// Idempotent. Spawns an unstructured Task that issues GET /api/sync/pull
    /// every `pullIntervalMs` until cancelled.
    func startPullPoller(for workspace: Workspace) {
        guard pullPollers[workspace.id] == nil else { return }
        let id = workspace.id
        let interval = pullIntervalMs
        pullPollers[id] = Task { [weak self] in
            // Initial tick on a tiny delay so AppDelegate finishes launching
            // before we hit the network.
            try? await Task.sleep(nanoseconds: 100_000_000)
            while !Task.isCancelled {
                await self?.pullTick(workspaceID: id)
                try? await Task.sleep(nanoseconds: interval * 1_000_000)
            }
        }
    }

    /// Iterates `workspaces` and starts a poller per workspace. Mirrors
    /// `startAllWatchers`'s testable-seam pattern.
    func startAllPullPollers() {
        workspaces.forEach { startPullPoller(for: $0) }
    }

    /// Idempotent.
    func stopPullPoller(for workspaceID: UUID) {
        pullPollers[workspaceID]?.cancel()
        pullPollers.removeValue(forKey: workspaceID)
    }

    /// One pull tick. Pauses watcher, drains up to `maxDrainPagesPerTick`
    /// pages from the server, persists the cursor, resumes the watcher.
    /// Internal access so tests can drive directly without spawning the
    /// background poller Task.
    func pullTick(workspaceID: UUID) async {
        guard let workspace = workspaces.first(where: { $0.id == workspaceID }) else { return }
        let snapshot = WorkspaceSnapshot(
            id: workspace.id,
            bearer: workspace.bearer,
            localFolder: workspace.localFolder
        )
        let watcher = watchers[workspaceID]
        watcher?.stop()

        var cursor = pullCursors[workspaceID]
        var pageCount = 0
        drainLoop: while pageCount < Self.maxDrainPagesPerTick {
            let outcome = await syncEngine.pull(
                workspace: snapshot,
                cursor: cursor,
                applyWrite: { [weak self] target, content in
                    await self?.writeFileWithMkdir(at: target, content: content)
                },
                applyDelete: { [weak self] target in
                    await self?.deleteFileIfExists(at: target)
                }
            )
            pageCount += 1
            switch outcome {
            case .caughtUp(let next):
                if let next { cursor = next }
                break drainLoop
            case .morePages(let next):
                cursor = next
            case .transportError:
                // Cursor unchanged; bail out for this tick.
                break drainLoop
            }
        }

        if let cursor {
            pullCursors[workspaceID] = cursor
            persistCursor(cursor, for: workspaceID)
        }
        watcher?.start()

        if pageCount >= Self.maxDrainPagesPerTick {
            NSLog("[Taproot] pullTick: hit D5 cap (\(Self.maxDrainPagesPerTick) pages); next tick will continue draining workspace \(workspaceID.uuidString)")
        }
    }

    private func writeFileWithMkdir(at target: URL, content: String) async {
        let dir = target.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try Data(content.utf8).write(to: target, options: .atomic)
        } catch {
            NSLog("[Taproot] pull: write failed for \(target.path): \(error)")
        }
    }

    private func deleteFileIfExists(at target: URL) async {
        let fm = FileManager.default
        guard fm.fileExists(atPath: target.path) else { return }
        do {
            try fm.removeItem(at: target)
        } catch {
            NSLog("[Taproot] pull: delete failed for \(target.path): \(error)")
        }
    }

    // MARK: - Cursor persistence (UserDefaults)

    /// Test seam matching `TAPROOT_BASE_URL` / `TAPROOT_KEYCHAIN_SERVICE` /
    /// `TAPROOT_LOCAL_FOLDER_BASE`: when set, cursor persistence routes
    /// through `UserDefaults(suiteName:)` so the E2E smoke can read the
    /// shipped cursor via `defaults read <suite> ...` without polluting the
    /// global domain. Inert in production unless set.
    private func cursorDefaults() -> UserDefaults {
        if let suite = ProcessInfo.processInfo.environment["TAPROOT_USERDEFAULTS_SUITE"],
           !suite.isEmpty,
           let suited = UserDefaults(suiteName: suite) {
            return suited
        }
        return .standard
    }

    private func persistCursor(_ cursor: PullCursor, for id: UUID) {
        let defaults = cursorDefaults()
        defaults.set(cursor.modifiedAt, forKey: "taproot.lastSync.\(id.uuidString)")
        defaults.set(cursor.id, forKey: "taproot.lastSyncId.\(id.uuidString)")
    }

    private func loadCursor(for id: UUID) -> PullCursor? {
        let defaults = cursorDefaults()
        guard
            let modifiedAt = defaults.string(forKey: "taproot.lastSync.\(id.uuidString)"),
            let cursorId = defaults.string(forKey: "taproot.lastSyncId.\(id.uuidString)"),
            !modifiedAt.isEmpty, !cursorId.isEmpty
        else {
            return nil
        }
        return PullCursor(modifiedAt: modifiedAt, id: cursorId)
    }

    private func clearCursor(for id: UUID) {
        let defaults = cursorDefaults()
        defaults.removeObject(forKey: "taproot.lastSync.\(id.uuidString)")
        defaults.removeObject(forKey: "taproot.lastSyncId.\(id.uuidString)")
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}
