import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?

    func applicationDidFinishLaunching(_: Notification) {
        // Required for menubar-only behavior when launched as an unbundled SwiftPM
        // binary. LSUIElement in Info.plist only takes effect inside a .app bundle;
        // setActivationPolicy(.accessory) is the runtime equivalent.
        NSApp.setActivationPolicy(.accessory)

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

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}
