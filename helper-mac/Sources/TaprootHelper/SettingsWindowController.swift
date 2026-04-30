import AppKit

/// Stage 1 settings window. Three-row form for T11.8: vault folder,
/// sync interval, version + Check-for-updates.
///
/// Tested transitively via the `presentSettings` / `revealInFinder`
/// closure seams on `AppDelegate`, plus the Coordinator-level wiring on
/// `UpdateCoordinator`. The window controller itself is not unit-tested —
/// AppKit lifecycle is flaky in headless XCTest, and the per-row behavior
/// is locked at the higher seams (mirrors how `NSStatusItem` is not
/// directly tested; `buildMenu` is tested as a pure function instead).
@MainActor
final class SettingsWindowController: NSWindowController {
    private let vaultFolderURL: URL?
    private let intervalLabel: String
    private let versionLabel: String
    private let onRevealVaultFolder: (URL) -> Void
    private let onCheckForUpdates: () -> Void

    init(
        vaultFolderURL: URL?,
        intervalLabel: String,
        versionLabel: String,
        onRevealVaultFolder: @escaping (URL) -> Void,
        onCheckForUpdates: @escaping () -> Void
    ) {
        self.vaultFolderURL = vaultFolderURL
        self.intervalLabel = intervalLabel
        self.versionLabel = versionLabel
        self.onRevealVaultFolder = onRevealVaultFolder
        self.onCheckForUpdates = onCheckForUpdates
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 200),
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

        // Row 3: Version + Check-for-updates (Sparkle's standard window)
        let versionField = NSTextField(labelWithString: versionLabel)
        let updatesButton = NSButton(
            title: "Check for updates…",
            target: self,
            action: #selector(checkUpdatesClicked(_:))
        )
        updatesButton.bezelStyle = .rounded
        let row3 = NSStackView(views: [versionField, updatesButton])
        row3.orientation = .horizontal
        row3.spacing = 8
        grid.addRow(with: [NSTextField(labelWithString: "Version:"), row3])

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

    @objc private func revealClicked(_ sender: NSButton) {
        guard let url = vaultFolderURL else { return }
        onRevealVaultFolder(url)
    }

    @objc private func checkUpdatesClicked(_ sender: NSButton) {
        onCheckForUpdates()
    }
}
