import AppKit

/// Sign-in panel shown when the user clicks "Sign in to Taproot…" from the
/// menubar. Accepts email + password, shows a loading state while the network
/// call is in flight, and renders inline errors below the form. Mirrors
/// `PairWindowController` in structure: `handleSubmit`/`handleCancel` are
/// internal for testability; `didFinish` prevents double-cancel on red-X.
@MainActor
final class AuthWindowController: NSWindowController, NSWindowDelegate {
    private let onSubmit: (String, String) -> Void
    private let onCancel: () -> Void
    private let onSignUpRequested: () -> Void
    private var didFinish = false
    private(set) weak var emailField: NSTextField?
    private(set) weak var passwordField: NSSecureTextField?
    private(set) weak var errorLabel: NSTextField?
    private(set) weak var submitButton: NSButton?

    init(
        onSubmit: @escaping (String, String) -> Void,
        onCancel: @escaping () -> Void,
        onSignUpRequested: @escaping () -> Void
    ) {
        self.onSubmit = onSubmit
        self.onCancel = onCancel
        self.onSignUpRequested = onSignUpRequested
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 210),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Sign in to Taproot"
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
        let email = emailField?.stringValue ?? ""
        let password = passwordField?.stringValue ?? ""
        guard !email.isEmpty else {
            showInlineError("Enter your email.")
            return
        }
        guard !password.isEmpty else {
            showInlineError("Enter your password.")
            return
        }
        setLoading(true)
        onSubmit(email, password)
    }

    func showInlineError(_ message: String) {
        errorLabel?.stringValue = message
        errorLabel?.isHidden = false
        setLoading(false)
    }

    private func setLoading(_ loading: Bool) {
        submitButton?.title = loading ? "Signing in…" : "Sign in"
        submitButton?.isEnabled = !loading
        emailField?.isEnabled = !loading
        passwordField?.isEnabled = !loading
    }

    func windowWillClose(_ notification: Notification) {
        if !didFinish {
            onCancel()
        }
    }

    @objc private func submitClicked(_ sender: NSButton) { handleSubmit() }
    @objc private func cancelClicked(_ sender: NSButton) { handleCancel() }
    @objc private func signUpClicked(_ sender: NSButton) {
        didFinish = true
        window?.close()
        onSignUpRequested()
    }

    private func buildContentView() {
        let grid = NSGridView()
        grid.translatesAutoresizingMaskIntoConstraints = false
        grid.columnSpacing = 16
        grid.rowSpacing = 10

        let instruction = NSTextField(labelWithString: "Sign in with your Taproot account:")
        grid.addRow(with: [instruction])

        let email = NSTextField()
        email.placeholderString = "Email"
        email.bezelStyle = .roundedBezel
        email.cell?.wraps = false
        grid.addRow(with: [email])
        emailField = email

        let password = NSSecureTextField()
        password.placeholderString = "Password"
        password.bezelStyle = .roundedBezel
        grid.addRow(with: [password])
        passwordField = password

        let error = NSTextField(labelWithString: "")
        error.textColor = .systemRed
        error.isHidden = true
        error.lineBreakMode = .byWordWrapping
        error.maximumNumberOfLines = 0
        grid.addRow(with: [error])
        errorLabel = error

        let cancelButton = NSButton(title: "Cancel", target: self, action: #selector(cancelClicked(_:)))
        cancelButton.bezelStyle = .rounded
        let submit = NSButton(title: "Sign in", target: self, action: #selector(submitClicked(_:)))
        submit.bezelStyle = .rounded
        submit.keyEquivalent = "\r"
        submitButton = submit
        let buttonRow = NSStackView(views: [NSView(), cancelButton, submit])
        buttonRow.orientation = .horizontal
        buttonRow.spacing = 8
        buttonRow.distribution = .fill
        grid.addRow(with: [buttonRow])

        let signUpButton = NSButton(
            title: "Don't have an account? Create one in your browser →",
            target: self,
            action: #selector(signUpClicked(_:))
        )
        signUpButton.bezelStyle = .inline
        signUpButton.isBordered = false
        signUpButton.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        grid.addRow(with: [signUpButton])

        let container = NSView()
        container.addSubview(grid)
        NSLayoutConstraint.activate([
            grid.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 24),
            grid.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -24),
            grid.topAnchor.constraint(equalTo: container.topAnchor, constant: 24),
            grid.bottomAnchor.constraint(lessThanOrEqualTo: container.bottomAnchor, constant: -24),
        ])
        window?.contentView = container
        // NSGridView can reset `isHidden` during layout; enforce it after layout completes.
        errorLabel?.isHidden = true
    }
}
