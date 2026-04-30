import AppKit

/// Failure modes from `FirstRunCoordinator.fetchWorkspaceName` (the /api/me
/// lookup that kicks off the first-run flow). Mapped to user-facing copy by
/// `FirstRunCoordinator.firstRunErrorMessage(_:)`.
enum FirstRunError: Error, Equatable {
    case notWired
    case unauthorized
    case transport
    case decodeFailed
    case http(Int)
}

/// Owns the first-connect deep-link → /api/me lookup → welcome window flow.
/// Extracted from AppDelegate (T11.8 commit 2). AppDelegate retains
/// `handleAuthURL` as the entry point and `confirmFirstRun` / `cancelFirstRun`
/// as the lifecycle hooks (those mutate watchers + pollers + Keychain, all
/// AppDelegate-owned state). This Coordinator owns the 5 first-run closure
/// seams + `wireDefaults()` + the welcome-window strong-ref ivar.
@MainActor
final class FirstRunCoordinator {
    private let services: Services
    private let onCancelFirstRun: (UUID) -> Void
    private let onConfirmFirstRun: (UUID, String, String, URL) -> Void
    private let defaultLocalFolderProvider: (UUID, String?) -> URL

    /// Test seam: opens the welcome window for a never-seen workspace ID.
    /// Default no-op; production impl wired in `wireDefaults()`.
    var presentFirstRun: @MainActor (UUID, String) -> Void = { _, _ in }
    /// Test seam: GET /api/me with the bearer to fetch workspace_name.
    /// Default returns `.notWired`; production impl in `wireDefaults()`.
    var fetchWorkspaceName: @MainActor (UUID, String) async -> Result<String, FirstRunError> = { _, _ in .failure(.notWired) }
    /// Test seam: factory for the welcome window. Returns the abstract
    /// NSWindowController so tests can inject a stub.
    var makeFirstRunWindow: @MainActor (UUID, String, String, URL, @escaping (UUID) -> Void, @escaping (UUID, String, URL) -> Void) -> NSWindowController = { _, _, _, _, _, _ in NSWindowController() }
    /// Test seam: shows a failure alert when /api/me cannot be fetched or its
    /// body lacks workspace_name.
    var presentFirstRunFailureAlert: @MainActor (String) -> Void = { _ in }
    /// Test seam: opens the website's signin URL when the user picks
    /// "Connect your Taproot account".
    var openConnectURL: @MainActor (URL) -> Void = { _ in }

    /// Holds the welcome window so it isn't deallocated mid-flow. Reassigned
    /// when a new first-run window opens (existing one closed first per
    /// Refinement A — NSWindowController does NOT auto-close programmatic
    /// windows on dealloc).
    private var firstRunWindowController: NSWindowController?

    /// Sync gate used by UpdateCoordinator's relaunch postpone hook to
    /// hold Sparkle while the first-run window is on screen. Visibility
    /// flips to false when the user clicks Get-started or Cancel (both
    /// paths call `window?.close()`).
    var isFirstRunWindowOpen: Bool {
        firstRunWindowController?.window?.isVisible == true
    }

    init(
        services: Services,
        onCancelFirstRun: @escaping (UUID) -> Void,
        onConfirmFirstRun: @escaping (UUID, String, String, URL) -> Void,
        defaultLocalFolderProvider: @escaping (UUID, String?) -> URL
    ) {
        self.services = services
        self.onCancelFirstRun = onCancelFirstRun
        self.onConfirmFirstRun = onConfirmFirstRun
        self.defaultLocalFolderProvider = defaultLocalFolderProvider
    }

    /// Wires the production impls for the 5 first-run closure seams.
    /// Tests drive the wired fetchWorkspaceName / presentFirstRun without
    /// spawning the menubar item or the watcher/poller stack.
    func wireDefaults() {
        fetchWorkspaceName = { [weak self] _, bearer in
            guard let self else { return .failure(.notWired) }
            let url = self.services.baseURL.appendingPathComponent("api/me")
            let request = HTTPRequest(
                url: url,
                method: "GET",
                headers: ["Authorization": "Bearer \(bearer)"],
                body: Data()
            )
            do {
                let response = try await self.services.httpClient.send(request)
                switch response.status {
                case 200..<300:
                    struct MeBody: Decodable { let workspace_name: String? }
                    guard let body = try? JSONDecoder().decode(MeBody.self, from: response.body),
                          let name = body.workspace_name, !name.isEmpty else {
                        return .failure(.decodeFailed)
                    }
                    return .success(name)
                case 401:
                    return .failure(.unauthorized)
                default:
                    return .failure(.http(response.status))
                }
            } catch {
                return .failure(.transport)
            }
        }

        makeFirstRunWindow = { id, bearer, name, defaultURL, onCancel, onConfirm in
            FirstRunWindowController(
                workspaceID: id,
                bearer: bearer,
                workspaceName: name,
                defaultFolderURL: defaultURL,
                onCancel: onCancel,
                onConfirm: onConfirm
            )
        }

        presentFirstRunFailureAlert = { msg in
            let alert = NSAlert()
            alert.messageText = "Connection failed"
            alert.informativeText = msg
            alert.addButton(withTitle: "OK")
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
        }

        openConnectURL = { url in
            NSWorkspace.shared.open(url)
        }

        presentFirstRun = { [weak self] id, bearer in
            guard let self else { return }
            Task { @MainActor [weak self] in
                guard let self else { return }
                let result = await self.fetchWorkspaceName(id, bearer)
                switch result {
                case .success(let name):
                    let slug = Slug.from(name)
                    let defaultURL = self.defaultLocalFolderProvider(id, slug)
                    if let existing = self.firstRunWindowController {
                        existing.window?.close()
                    }
                    let controller = self.makeFirstRunWindow(
                        id, bearer, name, defaultURL,
                        { [weak self] cancelID in self?.onCancelFirstRun(cancelID) },
                        { [weak self] confirmID, confirmBearer, confirmURL in
                            self?.onConfirmFirstRun(confirmID, confirmBearer, name, confirmURL)
                        }
                    )
                    self.firstRunWindowController = controller
                    NSApp.activate(ignoringOtherApps: true)
                    controller.showWindow(nil)
                case .failure(let err):
                    self.onCancelFirstRun(id)
                    self.presentFirstRunFailureAlert(self.firstRunErrorMessage(err))
                }
            }
        }
    }

    /// User-facing copy for first-run failure alerts.
    func firstRunErrorMessage(_ err: FirstRunError) -> String {
        switch err {
        case .unauthorized:
            return "Sign-in expired. Please try again."
        case .transport:
            return "Couldn't reach Taproot. Check your internet connection and try again."
        case .decodeFailed:
            return "Connection failed: server response missing workspace name."
        case .http(let status):
            return "Connection failed: server returned \(status)."
        case .notWired:
            return "Connection failed."
        }
    }
}
