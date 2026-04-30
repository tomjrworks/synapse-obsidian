import AppKit

/// Welcome window shown on first connect. Stub in commit 5 — only stores
/// the constructor args and shows an empty window. Full NSGridView form
/// (header, path label, Change…, warning row, Cancel + Get started) plus
/// the Obsidian Sync conflict gate land in commit 6.
@MainActor
final class FirstRunWindowController: NSWindowController {
    let workspaceID: UUID
    private let bearer: String
    private let workspaceName: String
    private(set) var currentURL: URL
    private let onCancel: (UUID) -> Void
    private let onConfirm: (UUID, String, URL) -> Void

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
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }
}
