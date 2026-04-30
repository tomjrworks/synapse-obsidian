import AppKit

/// Welcome window shown on first connect. Mirrors `SettingsWindowController`'s
/// programmatic-NSGridView shape. Per-action behavior (Cancel / Get started /
/// Change…) is exposed via internal `handle*` / `applyChosenFolder` so unit
/// tests can drive state transitions without spinning up an NSOpenPanel sheet.
@MainActor
final class FirstRunWindowController: NSWindowController {
    let workspaceID: UUID
    private let bearer: String
    private let workspaceName: String
    private let onCancel: (UUID) -> Void
    private let onConfirm: (UUID, String, URL) -> Void

    private(set) var currentURL: URL
    private(set) var isInConflict: Bool = false
    private(set) var isGetStartedEnabled: Bool = true

    /// Test seam: defaults to ObsidianSyncCheck.hasConflict. The single-arg
    /// `applyChosenFolder` overload routes through this so tests can verify
    /// the conflict path without writing a real `.obsidian/sync.json` file.
    var checkConflict: (URL) -> Bool = { ObsidianSyncCheck.hasConflict(at: $0) }

    private weak var pathLabel: NSTextField?
    private weak var warningLabel: NSTextField?
    private weak var getStartedButton: NSButton?

    init(workspaceID: UUID, bearer: String, workspaceName: String, defaultFolderURL: URL,
         onCancel: @escaping (UUID) -> Void,
         onConfirm: @escaping (UUID, String, URL) -> Void) {
        self.workspaceID = workspaceID
        self.bearer = bearer
        self.workspaceName = workspaceName
        self.currentURL = defaultFolderURL
        self.onCancel = onCancel
        self.onConfirm = onConfirm
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 200),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Welcome to Taproot"
        window.center()
        super.init(window: window)
        buildContentView()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func handleCancel() {
        onCancel(workspaceID)
        window?.close()
    }

    func handleGetStarted() {
        guard isGetStartedEnabled else { return }
        onConfirm(workspaceID, bearer, currentURL)
        window?.close()
    }

    /// One-arg overload: looks up conflict via the `checkConflict` seam.
    /// Used from `changeClicked` after the NSOpenPanel returns.
    func applyChosenFolder(_ url: URL) {
        applyChosenFolder(url, hasConflict: checkConflict(url))
    }

    func applyChosenFolder(_ url: URL, hasConflict: Bool) {
        currentURL = url
        isInConflict = hasConflict
        isGetStartedEnabled = !hasConflict
        pathLabel?.stringValue = url.path
        warningLabel?.isHidden = !hasConflict
        getStartedButton?.isEnabled = !hasConflict
    }

    @objc private func cancelClicked(_ sender: NSButton) { handleCancel() }
    @objc private func getStartedClicked(_ sender: NSButton) { handleGetStarted() }
    @objc private func changeClicked(_ sender: NSButton) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = currentURL
        guard let window else { return }
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let picked = panel.url else { return }
            Task { @MainActor in self?.applyChosenFolder(picked) }
        }
    }

    private func buildContentView() {
        let grid = NSGridView()
        grid.translatesAutoresizingMaskIntoConstraints = false
        grid.columnSpacing = 16
        grid.rowSpacing = 12

        let header = NSTextField(labelWithString: "Welcome to Taproot")
        header.font = .boldSystemFont(ofSize: 14)
        grid.addRow(with: [header])

        let subtitle = NSTextField(labelWithString: "We'll save your \(workspaceName) notes to:")
        grid.addRow(with: [subtitle])

        let path = NSTextField(labelWithString: currentURL.path)
        path.lineBreakMode = .byTruncatingMiddle
        path.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let changeButton = NSButton(title: "Change…", target: self, action: #selector(changeClicked(_:)))
        changeButton.bezelStyle = .rounded
        let pathRow = NSStackView(views: [path, changeButton])
        pathRow.orientation = .horizontal
        pathRow.spacing = 8
        grid.addRow(with: [pathRow])
        pathLabel = path

        let warning = NSTextField(labelWithString: "Obsidian Sync detected. Disable it or pick a different folder to avoid sync conflicts.")
        warning.textColor = .systemRed
        warning.isHidden = true
        warning.lineBreakMode = .byWordWrapping
        warning.maximumNumberOfLines = 0
        grid.addRow(with: [warning])
        warningLabel = warning

        let cancelButton = NSButton(title: "Cancel", target: self, action: #selector(cancelClicked(_:)))
        cancelButton.bezelStyle = .rounded
        let getStarted = NSButton(title: "Get started", target: self, action: #selector(getStartedClicked(_:)))
        getStarted.bezelStyle = .rounded
        getStarted.keyEquivalent = "\r"
        let buttonRow = NSStackView(views: [NSView(), cancelButton, getStarted])
        buttonRow.orientation = .horizontal
        buttonRow.spacing = 8
        buttonRow.distribution = .fill
        grid.addRow(with: [buttonRow])
        getStartedButton = getStarted

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
}
