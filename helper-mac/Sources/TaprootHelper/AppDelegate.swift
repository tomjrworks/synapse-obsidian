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

    /// `nonisolated` so `main.swift` (top-level synchronous code, no actor)
    /// and tests can construct AppDelegate without `await`. The init only stores
    /// a value-type ref; mutating methods + property access stay `@MainActor`.
    nonisolated init(services: Services = .production()) {
        self.services = services
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
                    localFolder: defaultLocalFolder(for: id),
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
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Documents")
        return docs.appendingPathComponent("Taproot/\(workspaceID.uuidString)")
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
                    localFolder: defaultLocalFolder(for: link.workspaceID),
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

    /// T11.2 stops here — log only. T11.3 will route these to the HTTP push client.
    private func handleFileChanges(workspaceID: UUID, events: [FileChangeEvent]) {
        NSLog("[Taproot] Watcher fired for \(workspaceID.uuidString): \(events.count) event(s)")
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}
