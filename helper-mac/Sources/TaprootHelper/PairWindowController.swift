import AppKit

/// Panel shown when the user clicks "Pair with code…" from the menubar.
/// Accepts a TAP-XXXX-XXXX pair code typed or pasted by the user, normalizes
/// it via `DeepLinkParser.canonicalizePairCode`, and calls `onSubmit` on the
/// canonical form. Mirrors the `FirstRunWindowController` structure:
/// `handleSubmit`/`handleCancel` are internal for testability; `didFinish`
/// prevents the `windowWillClose` red-X path from double-cancelling.
@MainActor
final class PairWindowController: NSWindowController, NSWindowDelegate {
    private let onSubmit: (String) -> Void
    private let onCancel: () -> Void
    private var didFinish = false
    private(set) weak var codeField: NSTextField?
    private weak var errorLabel: NSTextField?

    init(onSubmit: @escaping (String) -> Void,
         onCancel: @escaping () -> Void) {
        self.onSubmit = onSubmit
        self.onCancel = onCancel
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 170),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Connect to Taproot"
        window.center()
        super.init(window: window)
        window.delegate = self
        buildContentView()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func handleCancel() {
        didFinish = true
        window?.close()
        onCancel()
    }

    func handleSubmit() {
        let raw = codeField?.stringValue ?? ""
        guard let canonical = DeepLinkParser.canonicalizePairCode(raw) else {
            errorLabel?.stringValue = "Enter a valid pair code (format: TAP-XXXX-XXXX)."
            errorLabel?.isHidden = false
            return
        }
        didFinish = true
        window?.close()
        onSubmit(canonical)
    }

    func windowWillClose(_ notification: Notification) {
        if !didFinish {
            onCancel()
        }
    }

    @objc private func submitClicked(_ sender: NSButton) { handleSubmit() }
    @objc private func cancelClicked(_ sender: NSButton) { handleCancel() }

    private func buildContentView() {
        let grid = NSGridView()
        grid.translatesAutoresizingMaskIntoConstraints = false
        grid.columnSpacing = 16
        grid.rowSpacing = 12

        let instruction = NSTextField(labelWithString: "Enter the pair code shown on taproothq.com:")
        grid.addRow(with: [instruction])

        let field = NSTextField()
        field.placeholderString = "TAP-XXXX-XXXX"
        field.font = .monospacedSystemFont(ofSize: 16, weight: .regular)
        field.bezelStyle = .roundedBezel
        field.cell?.wraps = false
        grid.addRow(with: [field])
        codeField = field

        let error = NSTextField(labelWithString: "")
        error.textColor = .systemRed
        error.isHidden = true
        error.lineBreakMode = .byWordWrapping
        error.maximumNumberOfLines = 0
        grid.addRow(with: [error])
        errorLabel = error

        let cancelButton = NSButton(title: "Cancel", target: self, action: #selector(cancelClicked(_:)))
        cancelButton.bezelStyle = .rounded
        let submitButton = NSButton(title: "Connect", target: self, action: #selector(submitClicked(_:)))
        submitButton.bezelStyle = .rounded
        submitButton.keyEquivalent = "\r"
        let buttonRow = NSStackView(views: [NSView(), cancelButton, submitButton])
        buttonRow.orientation = .horizontal
        buttonRow.spacing = 8
        buttonRow.distribution = .fill
        grid.addRow(with: [buttonRow])

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
