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
    private let services: Services
    /// Internal access so tests can drive push-side wire-in checks.
    let syncEngine: SyncEngine

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
                    // §5: resolve symlinks so prefix-comparison in SyncEngine.toOp
                    // matches WorkspaceWatcher's already-canonicalized event paths.
                    localFolder: defaultLocalFolder(for: id).resolvingSymlinksInPath(),
                    lastSyncAt: nil,
                    syncStatus: .idle
                )
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
                    // §5: resolve symlinks (see loadWorkspacesFromKeychain).
                    localFolder: defaultLocalFolder(for: link.workspaceID).resolvingSymlinksInPath(),
                    lastSyncAt: nil,
                    syncStatus: .idle
                )
                workspaces.append(newWorkspace)
                startWatcher(for: newWorkspace)
            }
            NSLog("[Taproot] Stored bearer for workspace \(link.workspaceID.uuidString)")
        } catch {
            NSLog("[Taproot] Deep-link handling failed: \(error)")
        }
    }

    /// Stub for T11.5 menubar UI. Removes the Keychain entry + in-memory record.
    /// Stop the watcher BEFORE the do-block so a Keychain throw can't leave a
    /// running watcher attached to a workspace we're trying to delete.
    func signOut(workspaceID: UUID) {
        watchers[workspaceID]?.stop()
        watchers.removeValue(forKey: workspaceID)
        do {
            try services.keychain.delete(workspaceID: workspaceID)
            workspaces.removeAll { $0.id == workspaceID }
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

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}
