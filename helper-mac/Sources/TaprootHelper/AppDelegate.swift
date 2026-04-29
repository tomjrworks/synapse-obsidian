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
    private let keychain: KeychainStore

    /// `nonisolated` so `main.swift` (top-level synchronous code, no actor)
    /// and tests can construct AppDelegate without `await`. The init only stores
    /// a value-type ref; mutating methods + property access stay `@MainActor`.
    nonisolated init(keychain: KeychainStore = KeychainStore()) {
        self.keychain = keychain
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
            let entries = try keychain.retrieveAll()
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
            try keychain.store(workspaceID: link.workspaceID, bearer: link.bearer)
            if let idx = workspaces.firstIndex(where: { $0.id == link.workspaceID }) {
                workspaces[idx].bearer = link.bearer
            } else {
                workspaces.append(Workspace(
                    id: link.workspaceID,
                    name: "Workspace",
                    bearer: link.bearer,
                    localFolder: defaultLocalFolder(for: link.workspaceID),
                    lastSyncAt: nil,
                    syncStatus: .idle
                ))
            }
            NSLog("[Taproot] Stored bearer for workspace \(link.workspaceID.uuidString)")
        } catch {
            NSLog("[Taproot] Deep-link handling failed: \(error)")
        }
    }

    /// Stub for T11.5 menubar UI. Removes the Keychain entry + in-memory record.
    func signOut(workspaceID: UUID) {
        do {
            try keychain.delete(workspaceID: workspaceID)
            workspaces.removeAll { $0.id == workspaceID }
            NSLog("[Taproot] Signed out workspace \(workspaceID.uuidString)")
        } catch {
            NSLog("[Taproot] signOut failed: \(error)")
        }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}
