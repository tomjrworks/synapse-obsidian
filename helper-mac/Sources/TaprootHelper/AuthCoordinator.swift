import AppKit

/// Owns the in-app sign-in flow: presents `AuthWindowController`, drives the
/// two-hop API call via `AuthService`, and hands a valid bearer to
/// `AppDelegate.applyBearer(skipReauthConfirmation: true)` on success.
/// Mirrors the `FirstRunCoordinator` / `UpdateCoordinator` lazy-var pattern —
/// `wireDefaults()` must be called in `applicationDidFinishLaunching` before
/// `presentSignIn()` is ever invoked.
@MainActor
final class AuthCoordinator {
    private let services: Services
    private let onAuthSucceeded: (UUID, String) -> Void
    private let onCancel: () -> Void

    /// Factory for the auth window. Wired in `wireDefaults()`; tests override
    /// before calling `presentSignIn()` to inject a stub controller.
    var makeAuthWindow: (
        @escaping (String, String) -> Void,
        @escaping () -> Void,
        @escaping () -> Void
    ) -> NSWindowController = { _, _, _ in NSWindowController() }
    /// Returns the device name for the mint payload. Tests override.
    var deviceName: () -> String = { ProcessInfo.processInfo.hostName }
    /// Returns the OS platform string for the mint payload.
    var osPlatform: () -> String = { "darwin" }
    /// Opens the sign-up URL in the browser. Wired in `wireDefaults()`.
    var openSignUpURL: () -> Void = { }
    /// Presents a transient alert for unrecoverable server errors (rare;
    /// most errors render inline). Tests override to avoid blocking modals.
    var presentTransientErrorAlert: (String) -> Void = { message in
        let alert = NSAlert()
        alert.messageText = "Taproot sign-in"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        _ = alert.runModal()
    }

    private var authWindowController: NSWindowController?

    /// `true` while the sign-in window is visible. Used by `UpdateCoordinator`'s
    /// relaunch veto to prevent Sparkle from relaunching mid sign-in.
    var isAuthWindowOpen: Bool {
        authWindowController?.window?.isVisible ?? false
    }

    init(
        services: Services,
        onAuthSucceeded: @escaping (UUID, String) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.services = services
        self.onAuthSucceeded = onAuthSucceeded
        self.onCancel = onCancel
    }

    func wireDefaults() {
        makeAuthWindow = { onSubmit, onCancel, onSignUp in
            AuthWindowController(onSubmit: onSubmit, onCancel: onCancel, onSignUpRequested: onSignUp)
        }
        openSignUpURL = { [weak self] in
            guard let self else { return }
            self.services.openURL(URL(string: "https://taproothq.com/signup")!)
        }
    }

    /// Entry point from the "Sign in to Taproot…" menu item. Idempotent:
    /// brings an already-visible window to front rather than opening a second.
    func presentSignIn() {
        if let existing = authWindowController, existing.window?.isVisible == true {
            NSApp.activate(ignoringOtherApps: true)
            existing.showWindow(nil)
            return
        }
        let ctrl = makeAuthWindow(
            { [weak self] email, password in
                Task { @MainActor [weak self] in
                    await self?.signIn(email: email, password: password)
                }
            },
            { [weak self] in
                self?.authWindowController = nil
                self?.onCancel()
            },
            { [weak self] in
                self?.authWindowController = nil
                self?.openSignUpURL()
            }
        )
        authWindowController = ctrl
        NSApp.activate(ignoringOtherApps: true)
        ctrl.showWindow(nil)
    }

    private func signIn(email: String, password: String) async {
        let authWindow = authWindowController as? AuthWindowController
        switch await services.auth.signInWithSupabase(email: email, password: password) {
        case .failure(let err):
            authWindow?.showInlineError(localizedMessage(for: err))
            return
        case .success(let session):
            switch await services.auth.mintDeviceBearer(
                jwt: session.accessToken,
                deviceName: deviceName(),
                osPlatform: osPlatform()
            ) {
            case .failure(let err):
                authWindow?.showInlineError(localizedMessage(for: err))
                return
            case .success(let device):
                authWindowController?.window?.close()
                authWindowController = nil
                onAuthSucceeded(device.workspaceID, device.bearer)
            }
        }
    }

    private func localizedMessage(for error: AuthError) -> String {
        switch error {
        case .invalidCredentials:
            return "Invalid email or password."
        case .emailNotConfirmed:
            return "Please confirm your email — we sent you a link when you signed up."
        case .rateLimited:
            return "Too many attempts — try again in a minute."
        case .noWorkspace:
            return "Finish setup at taproothq.com first, then come back here."
        case .networkError:
            return "Couldn't reach Taproot. Check your connection and try again."
        case .server(let status, _):
            return "Something went wrong (status \(status)). Try again."
        }
    }
}
