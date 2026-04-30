import AppKit

/// Stage 1 T11.6 settings window. Five-row form: vault folder, sync interval,
/// notifications toggle, version + Sparkle placeholder, view sync log.
///
/// Tested transitively via the `presentSettings` / `revealInFinder` /
/// `openSyncLog` closure seams on `AppDelegate`. The window controller itself
/// is not unit-tested — AppKit lifecycle is flaky in headless XCTest, and the
/// per-row behavior is locked at the AppDelegate-level seams (mirrors how
/// `NSStatusItem` is not directly tested; `buildMenu` is tested as a pure
/// function instead).
@MainActor
final class SettingsWindowController: NSWindowController {
    private var settingsStore: SettingsStore
    private let vaultFolderURL: URL?
    private let intervalLabel: String
    private let versionLabel: String
    private let onRevealVaultFolder: (URL) -> Void
    private let onOpenSyncLog: () -> Void

    init(
        settingsStore: SettingsStore,
        vaultFolderURL: URL?,
        intervalLabel: String,
        versionLabel: String,
        onRevealVaultFolder: @escaping (URL) -> Void,
        onOpenSyncLog: @escaping () -> Void
    ) {
        self.settingsStore = settingsStore
        self.vaultFolderURL = vaultFolderURL
        self.intervalLabel = intervalLabel
        self.versionLabel = versionLabel
        self.onRevealVaultFolder = onRevealVaultFolder
        self.onOpenSyncLog = onOpenSyncLog
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 280),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Taproot Settings"
        window.center()
        super.init(window: window)
        buildContentView()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    private func buildContentView() {
        let grid = NSGridView()
        grid.translatesAutoresizingMaskIntoConstraints = false
        grid.columnSpacing = 16
        grid.rowSpacing = 12

        // Row 1: Vault folder + Reveal in Finder
        let pathString = vaultFolderURL?.path ?? "—"
        let pathLabel = NSTextField(labelWithString: pathString)
        pathLabel.lineBreakMode = .byTruncatingMiddle
        pathLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let revealButton = NSButton(
            title: "Reveal in Finder",
            target: self,
            action: #selector(revealClicked(_:))
        )
        revealButton.bezelStyle = .rounded
        revealButton.isEnabled = (vaultFolderURL != nil)
        let row1 = NSStackView(views: [pathLabel, revealButton])
        row1.orientation = .horizontal
        row1.spacing = 8
        grid.addRow(with: [NSTextField(labelWithString: "Vault folder:"), row1])

        // Row 2: Sync interval (read-only)
        grid.addRow(with: [
            NSTextField(labelWithString: "Sync interval:"),
            NSTextField(labelWithString: intervalLabel),
        ])

        // Row 3: Notifications toggle (persisted only — no real delivery yet)
        let toggle = NSButton(
            checkboxWithTitle: "",
            target: self,
            action: #selector(notificationsToggleChanged(_:))
        )
        toggle.state = settingsStore.notificationsEnabled ? .on : .off
        grid.addRow(with: [NSTextField(labelWithString: "Notifications:"), toggle])

        // Row 4: Version + disabled Sparkle placeholder
        let versionField = NSTextField(labelWithString: versionLabel)
        let updatesButton = NSButton(title: "Check for updates…", target: nil, action: nil)
        updatesButton.bezelStyle = .rounded
        updatesButton.isEnabled = false // TODO T11.8: wire Sparkle
        let row4 = NSStackView(views: [versionField, updatesButton])
        row4.orientation = .horizontal
        row4.spacing = 8
        grid.addRow(with: [NSTextField(labelWithString: "Version:"), row4])

        // Row 5: View sync log → Console.app
        let logButton = NSButton(
            title: "View sync log",
            target: self,
            action: #selector(openLogClicked(_:))
        )
        logButton.bezelStyle = .rounded
        grid.addRow(with: [NSTextField(labelWithString: ""), logButton])

        // Right-align the label column for a clean form look.
        if let labelColumn = grid.column(at: 0) as NSGridColumn? {
            labelColumn.xPlacement = .trailing
        }

        let container = NSView()
        container.addSubview(grid)
        NSLayoutConstraint.activate([
            grid.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 24),
            grid.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -24),
            grid.topAnchor.constraint(equalTo: container.topAnchor, constant: 24),
            grid.bottomAnchor.constraint(lessThanOrEqualTo: container.bottomAnchor, constant: -24),
        ])

        window?.contentView = container
    }

    @objc private func notificationsToggleChanged(_ sender: NSButton) {
        settingsStore.notificationsEnabled = (sender.state == .on)
    }

    @objc private func revealClicked(_ sender: NSButton) {
        guard let url = vaultFolderURL else { return }
        onRevealVaultFolder(url)
    }

    @objc private func openLogClicked(_ sender: NSButton) {
        onOpenSyncLog()
    }
}
