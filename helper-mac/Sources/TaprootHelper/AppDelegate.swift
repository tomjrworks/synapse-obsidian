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
    /// Internal access so tests can verify watcher lifecycle.
    var watchers: [UUID: WorkspaceWatcher] = [:]
    /// Internal access so tests can verify poller lifecycle.
    var pullPollers: [UUID: Task<Void, Never>] = [:]
    /// Internal access so tests can verify heartbeat lifecycle.
    var heartbeatTasks: [UUID: Task<Void, Never>] = [:]
    /// Internal access so tests can verify cursor advance + clear.
    var pullCursors: [UUID: PullCursor] = [:]
    /// Test seam: the most recent NSMenu produced by `rebuildMenu`. `private(set)`
    /// so tests can read but external code can't mutate it. Always non-nil after
    /// the first `rebuildMenu` call (which `applicationDidFinishLaunching` runs).
    private(set) var currentMenu: NSMenu?
    /// Test seam: fires inside `mutateWorkspaces` after the body runs (and
    /// before `rebuildMenu`). Receives a snapshot of the post-mutation
    /// workspaces. Default no-op; tests inject to capture mutation history
    /// without racing through actor boundaries.
    var workspaceMutationObserver: ([Workspace]) -> Void = { _ in }
    /// Confirmation gate for menu-driven sign-out. Returns true to proceed,
    /// false to cancel. Default: modal NSAlert with consequence text. Tests
    /// inject a stub returning true / false to drive both paths without an
    /// interactive run-loop. The 401 callback path bypasses this entirely
    /// (forced sign-out).
    var confirmSignOut: (Workspace) -> Bool = { workspace in
        let alert = NSAlert()
        alert.messageText = "Sign out of \(workspace.name)?"
        alert.informativeText = "This disconnects from Taproot. Your local files stay on disk. You'll need to re-authenticate to resume sync."
        alert.addButton(withTitle: "Sign out")
        alert.addButton(withTitle: "Cancel")
        // LSUIElement apps render alerts unfocused without an explicit
        // activation — defeats the point of confirmation.
        NSApp.activate(ignoringOtherApps: true)
        return alert.runModal() == .alertFirstButtonReturn
    }
    /// Confirmation gate for `taproot://` re-auth on an EXISTING workspace.
    /// Returns true to rotate the bearer, false to abort. Default: modal NSAlert
    /// with consequence text. Tests inject a stub returning true / false to
    /// drive both paths without an interactive run-loop. The first-connect
    /// branch of handleAuthURL bypasses this entirely (no existing bearer to
    /// protect).
    ///
    /// Rationale: a malicious webpage opening
    /// `taproot://auth?bearer=<attacker>&workspace=<victim-uuid>` would
    /// otherwise silently rotate the helper's stored bearer to the attacker,
    /// causing subsequent push ticks to mirror the victim's vault into the
    /// attacker's encrypted workspace. /security-audit C3 (2026-04-30).
    var confirmReauth: (Workspace) -> Bool = { workspace in
        let alert = NSAlert()
        alert.messageText = "Re-authorize \(workspace.name)?"
        alert.informativeText = "This replaces your existing connection to Taproot for this workspace. Only proceed if you started this re-auth from taproothq.com."
        alert.addButton(withTitle: "Replace connection")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        return alert.runModal() == .alertFirstButtonReturn
    }
    /// Test seam (T11.6): opens the Settings window. Default impl is wired
    /// in `applicationDidFinishLaunching` because it captures `[weak self]`
    /// and accesses MainActor state (settingsWindowController, NSApp), and
    /// the nonisolated init can't host that closure. Tests inject a stub
    /// before invocation.
    var presentSettings: @MainActor () -> Void = { }
    /// Test seam (T11.6): reveals a path in Finder. Default uses NSWorkspace.
    var revealInFinder: @MainActor (URL) -> Void = { url in
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }
    /// Single shared settings window controller. Lazily created on first
    /// `presentSettings()` invocation; closing the window hides it but
    /// does NOT release the controller (NSWindowController default).
    /// `private(set)` so tests can read post-construction state (e.g.,
    /// drive the Check-for-updates button) without mutating it directly,
    /// mirroring the `currentMenu` test seam.
    private(set) var settingsWindowController: SettingsWindowController?
    /// First-run flow: extracted in T11.8 commit 2 per audit-3 A1.
    /// Lazy so `nonisolated init` doesn't construct it on the wrong actor;
    /// `applicationDidFinishLaunching` triggers materialization by calling
    /// `firstRun.wireDefaults()`. Tests reassign `firstRun = customCoord`
    /// before first access if they need a different shape; closure seams
    /// (`firstRun.presentFirstRun = ...`) can be overridden after.
    lazy var firstRun: FirstRunCoordinator = makeFirstRunCoordinator()
    /// Auto-update flow: extracted in T11.8 commit 4. Same lazy + factory
    /// pattern as `firstRun`. Tests override `makeUpdaterService` BEFORE
    /// first `updates` access to inject a `FakeUpdaterService`.
    lazy var updates: UpdateCoordinator = UpdateCoordinator(
        updater: makeUpdaterService(),
        settingsStore: settingsStore
    )
    /// In-app sign-in flow (Phase 3). Same lazy pattern as `firstRun` and
    /// `updates`. Tests reassign before first access to inject stubs.
    lazy var auth: AuthCoordinator = makeAuthCoordinator()
    /// PKCE verifier storage for the /signin code-exchange flow (B1).
    /// `menuConnectAccount` calls `beginSignin()` to seed; `handleAuthURL`
    /// calls `consumeVerifier()` on the deep-link callback. Per-instance
    /// (not a singleton) so tests can swap a fake. Single-user UX, so the
    /// "most-recent-wins" semantics inside PKCEStore are acceptable.
    var pkceStore: PKCEStore = PKCEStore()
    /// Test seam for the "no active sign-in" alert. Default presents an
    /// NSAlert; tests override to drive both the alert path and the
    /// happy path without blocking on a modal in headless XCTest.
    var presentSigninError: @MainActor (String) -> Void = { message in
        let alert = NSAlert()
        alert.messageText = "Taproot sign-in"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        _ = alert.runModal()
    }
    /// Test seam for pair-flow errors (B6). Default presents an NSAlert;
    /// tests override to inspect error messages without blocking on a modal.
    var presentPairError: @MainActor (String) -> Void = { message in
        let alert = NSAlert()
        alert.messageText = "Taproot pairing"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        _ = alert.runModal()
    }
    /// Holds the paste-the-code window so it isn't deallocated mid-flow (B6).
    /// Nil when the window is closed or not yet opened.
    var pairWindowController: PairWindowController?
    /// Factory for the underlying UpdaterService; default returns the
    /// production `SparkleUpdaterService`. Override in tests before first
    /// `updates` access.
    var makeUpdaterService: @MainActor () -> UpdaterService = {
        SparkleUpdaterService()
    }
    private let services: Services
    /// Internal access so tests can drive push-side wire-in checks.
    let syncEngine: SyncEngine

    /// Polling interval in ms. `TAPROOT_PULL_INTERVAL_MS` env-var seam matches
    /// the existing `TAPROOT_BASE_URL` / `TAPROOT_LOCAL_FOLDER_BASE` test
    /// pattern. Read at instance construction; tests set the env before init.
    /// Internal access (T11.6): SettingsWindowController reads it for the
    /// "Sync interval:" row.
    let pullIntervalMs: UInt64 = {
        if let raw = ProcessInfo.processInfo.environment["TAPROOT_PULL_INTERVAL_MS"],
           let n = UInt64(raw), n > 0 {
            return n
        }
        return 30_000
    }()

    /// T11.6 settings persistence (pause-on-launch flag, T11.8 auto-download
    /// flag). Lazily constructed against `taprootDefaults()` so the env-var
    /// seam matches the existing cursor persistence path.
    lazy var settingsStore: SettingsStore = SettingsStore(defaults: taprootDefaults())

    /// D5 cap: max pages drained per tick. Bounds the watcher-pause window to
    /// roughly 5000 files / 10s on initial pull of a large workspace.
    static let maxDrainPagesPerTick = 10

    /// `nonisolated` so `main.swift` (top-level synchronous code, no actor)
    /// and tests can construct AppDelegate without `await`. The init only stores
    /// a value-type ref; mutating methods + property access stay `@MainActor`.
    nonisolated init(services: Services = .production()) {
        self.services = services
        self.syncEngine = SyncEngine(httpClient: services.httpClient, baseURL: services.baseURL)
        super.init()
    }

    /// Constructs the production AuthCoordinator. Called by the lazy `auth`
    /// initializer on first access. Tests bypass by reassigning `app.auth`.
    private func makeAuthCoordinator() -> AuthCoordinator {
        AuthCoordinator(
            services: services,
            onAuthSucceeded: { [weak self] workspaceID, bearer in
                self?.applyBearer(workspaceID: workspaceID, bearer: bearer, skipReauthConfirmation: true)
            },
            onCancel: { }
        )
    }

    /// Constructs the production FirstRunCoordinator with bridges back to
    /// AppDelegate's lifecycle methods. Called by the lazy `firstRun`
    /// initializer on first access. Tests bypass this by reassigning
    /// `app.firstRun = customCoord` before first use.
    private func makeFirstRunCoordinator() -> FirstRunCoordinator {
        FirstRunCoordinator(
            services: services,
            onCancelFirstRun: { [weak self] id in
                self?.cancelFirstRun(workspaceID: id)
            },
            onConfirmFirstRun: { [weak self] id, bearer, name, url in
                self?.confirmFirstRun(
                    workspaceID: id,
                    bearer: bearer,
                    name: name,
                    vaultFolder: url
                )
            },
            defaultLocalFolderProvider: { [weak self] id, slug in
                self?.defaultLocalFolder(for: id, slug: slug)
                    ?? URL(fileURLWithPath: "/")
            }
        )
    }

    /// Resolves the version label for the Settings window's "Version:" row.
    /// Bundle lookup is parameterized so tests can drive both the present
    /// and the missing-key branches without depending on Info.plist
    /// build-time embedding. Mirrors the test-seam pattern at
    /// `BaseURLResolver.swift:9-11`.
    static func resolveVersionLabel(
        bundleLookup: (String) -> Any? = { Bundle.main.object(forInfoDictionaryKey: $0) }
    ) -> String {
        (bundleLookup("CFBundleShortVersionString") as? String) ?? "dev"
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

        // Wire the default `presentSettings` impl now that we have @MainActor
        // context (init is nonisolated for main.swift compatibility). Tests
        // inject their own stub before invocation, overwriting this default.
        // LSUIElement gotcha matching `confirmSignOut`: activate BEFORE
        // showWindow or the panel opens behind other apps.
        presentSettings = { [weak self] in
            guard let self else { return }
            if self.settingsWindowController == nil {
                let url = self.workspaces.first?.localFolder
                let interval = "\(self.pullIntervalMs / 1000)s"
                let version = AppDelegate.resolveVersionLabel()
                self.settingsWindowController = SettingsWindowController(
                    vaultFolderURL: url,
                    intervalLabel: interval,
                    versionLabel: version,
                    onRevealVaultFolder: { [weak self] u in self?.revealInFinder(u) },
                    onCheckForUpdates: { [weak self] in self?.updates.checkForUpdates() }
                )
            }
            NSApp.activate(ignoringOtherApps: true)
            self.settingsWindowController?.showWindow(nil)
        }

        // Wire the first-run production defaults BEFORE
        // loadWorkspacesFromKeychain. The URL handler is registered in
        // applicationWillFinishLaunching, so a launch-via-deep-link can queue
        // handleAuthURL very early — every seam it might hit must already be
        // production-wired.
        firstRun.wireDefaults()
        auth.wireDefaults()

        loadWorkspacesFromKeychain()
        // F0: rename legacy `.synapse/` → `.taproot/` for each restored
        // workspace BEFORE startAllWatchers fires. Otherwise FSEvents
        // would report `.synapse/` paths in the brief window before the
        // rename, leaking the legacy directory name into push events.
        // Idempotent — no-ops when the rename has already happened.
        for workspace in workspaces {
            SynapseMigration.migrate(in: workspace.localFolder)
        }
        // T11.6: mark workspaces flagged paused-on-launch as `.paused` BEFORE
        // startAllWatchers/startAllPullPollers run. The early-return guards
        // in those methods then no-op for `.paused` workspaces.
        resumePausedFromUserDefaults()
        // Wire SyncEngine's 401 callback to AppDelegate.signOut. `[weak self]`
        // because the engine outlives a notional teardown, and we don't want
        // its callback to keep AppDelegate alive past app shutdown.
        Task { [weak self] in
            await self?.syncEngine.setOnUnauthorized { [weak self] id in
                self?.signOut(workspaceID: id)
            }
        }
        startAllWatchers()
        startAllPullPollers()
        startAllHeartbeats()

        // Start the auto-updater AFTER watchers + pollers so a launch-via-
        // deep-link (firstRun window opening, watchers spinning up) settles
        // before the first scheduled update check fires. The relaunch veto
        // postpones Sparkle while either the first-run window is up OR a
        // push is in flight (V3 atomic counter on SyncEngine).
        updates.isBusy = { [weak self, syncEngine] in
            (syncEngine.pushInFlight > 0)
                || (self?.firstRun.isFirstRunWindowOpen ?? false)
                || (self?.auth.isAuthWindowOpen ?? false)
        }
        updates.diagnosticSnapshot = { [weak self, syncEngine] in
            let pif = syncEngine.pushInFlight
            let frw = self?.firstRun.isFirstRunWindowOpen ?? false
            let aw = self?.auth.isAuthWindowOpen ?? false
            return "isBusy=\(pif > 0 || frw || aw); pushInFlight=\(pif); firstRunWindowOpen=\(frw); authWindowOpen=\(aw)"
        }
        updates.start()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        rebuildMenu()

        // Smoke-only seam (Refinement C): synthesize a deep link from env if
        // set. Inert in release. Closes the unbundled-binary smoke gap —
        // CFBundleURLTypes only registers `taproot://` inside a .app bundle,
        // so `swift run TaprootHelper` can't receive real URL events. See
        // ~/.claude/projects/-Users-miloman/memory/reference_taproot_smoke_gotchas.md.
        //
        // C2 (build-audit-3): gated to unbundled binaries — production .app
        // archives always have a bundle identifier, `swift run` does not.
        // Combined with the taproot:// scheme check, this prevents a
        // launchctl-injected non-taproot URL from ever reaching handleAuthURL
        // on a real user's machine even if they have local user-context code
        // execution. Pattern mirrors `BaseURLResolver.swift:13-22`.
        if Bundle.main.bundleIdentifier == nil,
           let injected = ProcessInfo.processInfo.environment["TAPROOT_DEV_INJECT_DEEPLINK"],
           let url = URL(string: injected),
           url.scheme == "taproot" {
            Task { @MainActor [weak self] in self?.dispatchURL(url) }
        }
    }

    @objc func menuConnectAccount(_ sender: NSMenuItem) {
        // B1: seed a PKCE challenge before opening the browser. The
        // matching verifier is held in memory until the deep-link
        // callback (`handleAuthURL`) consumes it for /signin/exchange.
        let (challenge, method) = pkceStore.beginSignin()
        var components = URLComponents(
            url: services.baseURL.appendingPathComponent("signin"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [
            URLQueryItem(name: "source", value: "helper"),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: method),
        ]
        guard let url = components.url else { return }
        firstRun.openConnectURL(url)
    }

    /// Routes every `workspaces` mutation through a single helper so the
    /// menubar always reflects current state. Callers MUST use this instead
    /// of mutating `workspaces` directly — a forgotten call site is a
    /// code-review / test catch, not a runtime silent failure.
    func mutateWorkspaces(_ body: (inout [Workspace]) -> Void) {
        body(&workspaces)
        workspaceMutationObserver(workspaces)
        rebuildMenu()
    }

    /// Projects current `workspaces` state onto the menubar icon + dropdown,
    /// and updates the `currentMenu` test seam. Called from `mutateWorkspaces`
    /// after every mutation. Safe when `statusItem == nil` (tests construct
    /// AppDelegate without ever realizing the NSStatusItem).
    func rebuildMenu() {
        let menu = buildMenu(for: workspaces)
        currentMenu = menu
        statusItem?.button?.image = NSImage(
            systemSymbolName: statusIconName(for: workspaces),
            accessibilityDescription: "Taproot"
        )
        statusItem?.menu = menu
    }

    func loadWorkspacesFromKeychain() {
        do {
            let entries = try services.keychain.retrieveAll()
            let loaded = entries.map { (id, bearer) -> Workspace in
                let storedName = settingsStore.workspaceName(for: id)
                let nameValue = storedName ?? "Workspace"
                let folderValue = settingsStore.vaultFolder(for: id)
                    ?? defaultLocalFolder(for: id, slug: storedName.flatMap(Slug.from))
                return Workspace(
                    id: id,
                    name: nameValue,
                    bearer: bearer,
                    // §5: canonicalize so prefix-comparison in SyncEngine.toOp
                    // matches WorkspaceWatcher's already-canonicalized event paths.
                    // `canonicalPath` uses realpath() so firmlinks (`/var` →
                    // `/private/var` on macOS Catalina+) resolve, which
                    // `resolvingSymlinksInPath()` alone does not.
                    localFolder: folderValue.canonicalPath,
                    lastSyncAt: nil,
                    syncStatus: .idle
                )
            }
            mutateWorkspaces { $0 = loaded }
            // Seed cursors from UserDefaults so the first pull tick after
            // launch resumes from where the previous session left off (or
            // initial-pull if never persisted).
            for ws in workspaces {
                if let c = loadCursor(for: ws.id) {
                    pullCursors[ws.id] = c
                }
            }
            NSLog("[Taproot] Loaded \(workspaces.count) workspace(s) from Keychain")
        } catch {
            NSLog("[Taproot] Keychain retrieveAll failed: \(error)")
            mutateWorkspaces { $0 = [] }
        }
    }

    func defaultLocalFolder(for workspaceID: UUID, slug: String? = nil) -> URL {
        // Post-B (Obsidian-required pivot): no longer the production path for
        // *new* connects — FirstRunWindowController auto-detects the user's
        // Obsidian vault via ObsidianVaultResolver. Retained as the
        // fallback for `loadWorkspacesFromKeychain` when a stored
        // vaultFolder is missing (legacy ~/Documents/Taproot/<slug>
        // workspaces still resolve here until the user re-pairs).
        // `TAPROOT_LOCAL_FOLDER_BASE` is a smoke-test seam (T11.3 §7); inert in
        // production unless set, in which case the base directory is rooted
        // wherever the smoke driver chose. Always logged at launch via the
        // surrounding callers' workspace-load NSLog.
        let base = ProcessInfo.processInfo.environment["TAPROOT_LOCAL_FOLDER_BASE"]
            .flatMap { URL(fileURLWithPath: $0) }
            ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Documents")
        let leaf = slug ?? workspaceID.uuidString
        return base.appendingPathComponent("Taproot/\(leaf)")
    }

    @objc func handleGetURLEvent(_ event: NSAppleEventDescriptor, withReplyEvent _: NSAppleEventDescriptor) {
        guard let urlString = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue,
              let url = URL(string: urlString) else {
            NSLog("[Taproot] handleGetURLEvent: missing or invalid URL")
            return
        }
        dispatchURL(url)
    }

    /// Routes a `taproot://` URL to the correct handler based on host.
    /// Centralizes dispatch so both the AppleEvent path and the smoke-test
    /// injection seam share a single routing point.
    func dispatchURL(_ url: URL) {
        if url.host?.lowercased() == "pair" {
            handlePairURL(url)
        } else {
            handleAuthURL(url)
        }
    }

    /// Parses an auth deep link, exchanges the auth code for a bearer at
    /// POST /signin/exchange (B1), persists the bearer to Keychain, and
    /// either upserts on an existing workspace (re-auth) or hands off to
    /// the first-run flow for a never-seen workspace.
    ///
    /// The exchange POST happens on a background Task so this method
    /// returns synchronously. Tests drive both halves explicitly:
    /// inject a stubbed FakeHTTPClient response, call this method, await
    /// an expectation that fires from `applyBearer`.
    func handleAuthURL(_ url: URL) {
        do {
            let link = try DeepLinkParser.parseAuth(url)
            guard let verifier = pkceStore.consumeVerifier() else {
                NSLog("[Taproot] No active sign-in — PKCE verifier not seeded for \(link.workspaceID.uuidString)")
                presentSigninError(
                    "Sign-in link received without an active sign-in. Open the Taproot menu and click Connect again."
                )
                return
            }
            let workspaceID = link.workspaceID
            let code = link.code
            Task { @MainActor [weak self] in
                await self?.exchangeAndApply(
                    workspaceID: workspaceID,
                    code: code,
                    codeVerifier: verifier
                )
            }
        } catch {
            NSLog("[Taproot] Deep-link handling failed: \(error)")
        }
    }

    /// POSTs `{code, code_verifier}` to `<baseURL>/signin/exchange`,
    /// validates the response, and routes the bearer through
    /// `applyBearer`. Internal so tests can drive it directly with a
    /// FakeHTTPClient stubbed response.
    func exchangeAndApply(workspaceID: UUID, code: String, codeVerifier: String) async {
        let exchangeURL = services.baseURL.appendingPathComponent("signin/exchange")
        let payload: [String: String] = ["code": code, "code_verifier": codeVerifier]
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else {
            NSLog("[Taproot] /signin/exchange: failed to encode body")
            presentSigninError("Sign-in failed (encoding error). Please try again.")
            return
        }
        let req = HTTPRequest(
            url: exchangeURL,
            method: "POST",
            headers: ["Content-Type": "application/json"],
            body: body
        )
        do {
            let resp = try await services.httpClient.send(req)
            guard resp.status == 200 else {
                let errCode = (try? JSONSerialization.jsonObject(with: resp.body) as? [String: Any])?["error"] as? String
                let logCode = String((errCode ?? "unknown").prefix(64))
                NSLog("[Taproot] /signin/exchange failed: HTTP \(resp.status) error=\(logCode)")
                presentSigninError(messageForExchangeError(errCode ?? "unknown", status: resp.status))
                return
            }
            guard
                let json = try JSONSerialization.jsonObject(with: resp.body) as? [String: Any],
                let bearer = json["bearer"] as? String,
                let respWorkspaceStr = json["workspace_id"] as? String,
                let respWorkspaceID = UUID(uuidString: respWorkspaceStr)
            else {
                NSLog("[Taproot] /signin/exchange returned malformed response")
                presentSigninError("Sign-in failed (unexpected server response). Please try again.")
                return
            }
            // Defense in depth: server should echo the same workspace_id, but
            // verify before persisting so a corrupted response can't redirect us.
            guard respWorkspaceID == workspaceID else {
                NSLog("[Taproot] /signin/exchange workspace mismatch: deeplink=\(workspaceID.uuidString) resp=\(respWorkspaceID.uuidString)")
                presentSigninError("Sign-in failed (workspace mismatch). Please try again.")
                return
            }
            applyBearer(workspaceID: workspaceID, bearer: bearer)
        } catch {
            NSLog("[Taproot] /signin/exchange transport error: \(error)")
            presentSigninError("Couldn't reach Taproot to finish sign-in. Check your network and try again.")
        }
    }

    /// Persists the exchanged bearer and routes to either the re-auth path
    /// (existing workspace, requires confirmReauth unless trusted in-app path)
    /// or the first-run path (new workspace). /security-audit C3 (2026-04-30)
    /// gate is preserved for deep-link callers — only the in-app form passes
    /// `skipReauthConfirmation: true` since the user just typed their password.
    /// Internal access so tests can drive the post-exchange logic directly.
    func applyBearer(workspaceID: UUID, bearer: String, skipReauthConfirmation: Bool = false) {
        do {
            if let idx = workspaces.firstIndex(where: { $0.id == workspaceID }) {
                let existing = workspaces[idx]
                if !skipReauthConfirmation {
                    guard confirmReauth(existing) else {
                        NSLog("[Taproot] Re-auth cancelled by user for workspace \(workspaceID.uuidString)")
                        return
                    }
                }
                try services.keychain.store(workspaceID: workspaceID, bearer: bearer)
                mutateWorkspaces { $0[idx].bearer = bearer }
                NSLog("[Taproot] Updated bearer for existing workspace \(workspaceID.uuidString)")
            } else {
                try services.keychain.store(workspaceID: workspaceID, bearer: bearer)
                NSLog("[Taproot] New workspace \(workspaceID.uuidString) — opening first-run window")
                firstRun.presentFirstRun(workspaceID, bearer)
            }
        } catch {
            NSLog("[Taproot] applyBearer keychain store failed: \(error)")
            presentSigninError("Sign-in succeeded but storing the credential failed. Please try again.")
        }
    }

    private func messageForExchangeError(_ code: String, status: Int) -> String {
        switch code {
        case "expired":
            return "Your sign-in link expired. Open the Taproot menu and click Connect again."
        case "pkce_mismatch":
            return "Sign-in verification failed. Please try again."
        case "invalid_code", "invalid_verifier":
            return "Sign-in link was malformed. Please try again."
        case "server_error":
            return "Taproot couldn't finish sign-in. Please try again."
        default:
            return "Sign-in failed (HTTP \(status))."
        }
    }

    // MARK: - Pair flow (B6)

    /// Routes `taproot://pair?code=TAP-XXXX-XXXX` to `redeemAndApply`.
    /// Validates the code format before dispatching — invalid deep-links are
    /// logged and dropped rather than forwarded to the network.
    func handlePairURL(_ url: URL) {
        do {
            let link = try DeepLinkParser.parsePair(url)
            let code = link.code
            Task { @MainActor [weak self] in
                await self?.redeemAndApply(code: code)
            }
        } catch {
            NSLog("[Taproot] Pair deep-link handling failed: \(error)")
        }
    }

    /// POSTs `{code, device_name, os_platform}` to `<baseURL>/api/helper/pair/redeem`.
    /// On 200, routes the returned bearer through `applyBearer` — same Keychain
    /// lifecycle as the PKCE exchange path. Internal so tests can drive it directly
    /// with a stubbed FakeHTTPClient.
    func redeemAndApply(code: String) async {
        let redeemURL = services.baseURL.appendingPathComponent("api/helper/pair/redeem")
        let ver = ProcessInfo.processInfo.operatingSystemVersion
        let verStr = "\(ver.majorVersion).\(ver.minorVersion).\(ver.patchVersion)"
        #if arch(arm64)
        let arch = "arm64"
        #else
        let arch = "x86_64"
        #endif
        let payload: [String: String] = [
            "code": code,
            "device_name": ProcessInfo.processInfo.hostName,
            "os_platform": "macOS \(verStr) \(arch)",
        ]
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else {
            presentPairError("Pairing failed (encoding error). Please try again.")
            return
        }
        let req = HTTPRequest(
            url: redeemURL,
            method: "POST",
            headers: ["Content-Type": "application/json"],
            body: body
        )
        do {
            let resp = try await services.httpClient.send(req)
            guard resp.status == 200 else {
                let errCode = (try? JSONSerialization.jsonObject(with: resp.body) as? [String: Any])?["error"] as? String
                let logCode = String((errCode ?? "unknown").prefix(64))
                NSLog("[Taproot] /api/helper/pair/redeem failed: HTTP \(resp.status) error=\(logCode)")
                presentPairError(messageForRedeemError(errCode ?? "unknown", status: resp.status))
                return
            }
            guard
                let json = try JSONSerialization.jsonObject(with: resp.body) as? [String: Any],
                let bearer = json["bearer"] as? String,
                let wsStr = json["workspace_id"] as? String,
                let workspaceID = UUID(uuidString: wsStr)
            else {
                NSLog("[Taproot] /api/helper/pair/redeem returned malformed response")
                presentPairError("Pairing failed (unexpected server response). Please try again.")
                return
            }
            applyBearer(workspaceID: workspaceID, bearer: bearer)
        } catch {
            NSLog("[Taproot] /api/helper/pair/redeem transport error: \(error)")
            presentPairError("Couldn't reach Taproot to finish pairing. Check your network and try again.")
        }
    }

    private func messageForRedeemError(_ code: String, status: Int) -> String {
        switch code {
        case "expired":
            return "Your pair code expired. Go back to taproothq.com and generate a new one."
        case "already_consumed":
            return "This pair code has already been used. Generate a new one from taproothq.com."
        case "invalid_code":
            return "Pair code not found. Check the code and try again."
        case "bad_request":
            return "Pairing failed (bad request). Please try again."
        default:
            return "Pairing failed (HTTP \(status))."
        }
    }

    /// Opens the paste-the-code panel. Reuses an existing controller if the
    /// window is already on screen (idempotent — brings it front).
    func openPairWindow() {
        if pairWindowController == nil {
            pairWindowController = PairWindowController(
                onSubmit: { [weak self] code in
                    self?.pairWindowController = nil
                    Task { @MainActor [weak self] in
                        await self?.redeemAndApply(code: code)
                    }
                },
                onCancel: { [weak self] in
                    self?.pairWindowController = nil
                }
            )
        }
        NSApp.activate(ignoringOtherApps: true)
        pairWindowController?.showWindow(nil)
    }

    @objc func menuEnterPairCode(_ sender: NSMenuItem) {
        openPairWindow()
    }

    @objc func menuSignIn(_ sender: NSMenuItem) {
        auth.presentSignIn()
    }

    /// Persists workspace name + vault folder, appends the workspace to the
    /// in-memory list, and starts the watcher + pull poller. Called from the
    /// FirstRunWindowController's Get started callback (commit 5+).
    func confirmFirstRun(workspaceID: UUID, bearer: String, name: String, vaultFolder: URL) {
        settingsStore.setWorkspaceName(name, for: workspaceID)
        settingsStore.setVaultFolder(vaultFolder, for: workspaceID)
        let canonical = vaultFolder.canonicalPath
        // F0: migrate legacy `.synapse/` → `.taproot/` BEFORE startWatcher
        // attaches FSEvents to this vault. Same rationale as the launch-time
        // pass in applicationDidFinishLaunching; idempotent.
        SynapseMigration.migrate(in: canonical)
        let workspace = Workspace(
            id: workspaceID,
            name: name,
            bearer: bearer,
            localFolder: canonical,
            lastSyncAt: nil,
            syncStatus: .idle
        )
        // C1: dedup against rapid double-confirm (double-click "Get started"
        // before the window dismisses, or two presentFirstRun Tasks racing
        // through fetchWorkspaceName). Mirrors the firstIndex(where:) guard
        // in handleAuthURL:444. startWatcher/startPullPoller are already
        // idempotent on workspace.id, so this single guard is sufficient.
        mutateWorkspaces { wks in
            if !wks.contains(where: { $0.id == workspaceID }) {
                wks.append(workspace)
            }
        }
        startWatcher(for: workspace)
        startPullPoller(for: workspace)
        startHeartbeat(for: workspace)
        NSLog("[Taproot] First-run complete for \(workspaceID.uuidString) at \(canonical.path)")
    }

    /// Aborts a first-run flow before the workspace was appended. Deletes the
    /// Keychain bearer (handleAuthURL stored it pre-window) and clears any
    /// SettingsStore entries that may have been written. Distinct from
    /// `performSignOut` because the workspace was never added to the
    /// in-memory list, so no `mutateWorkspaces` removal is needed.
    func cancelFirstRun(workspaceID: UUID) {
        do {
            try services.keychain.delete(workspaceID: workspaceID)
        } catch {
            NSLog("[Taproot] cancelFirstRun: keychain delete failed: \(error)")
        }
        settingsStore.clearWorkspaceName(for: workspaceID)
        settingsStore.clearVaultFolder(for: workspaceID)
        NSLog("[Taproot] First-run cancelled for \(workspaceID.uuidString)")
    }

    /// Performs the destructive sign-out work without confirmation. The menu
    /// path wraps this in `confirmSignOut` (NSAlert); the 401 callback path
    /// calls it directly because that path is already a forced sign-out.
    /// Stop the poller AND the watcher BEFORE the do-block so a Keychain throw
    /// can't leave a running poller/watcher attached to a workspace we're
    /// trying to delete. Cancel poller first so an in-flight tick can't race
    /// a final pull through a stopped watcher.
    func performSignOut(workspaceID: UUID) {
        stopPullPoller(for: workspaceID)
        stopHeartbeat(workspaceID: workspaceID)
        watchers[workspaceID]?.stop()
        watchers.removeValue(forKey: workspaceID)

        // H1 (04-30): fire-and-forget /revoke before deleting from Keychain
        // so the bearer is invalidated server-side (RFC 7009). Never blocks
        // sign-out — a failed revoke still completes the local sign-out.
        let bearerToRevoke = workspaces.first(where: { $0.id == workspaceID })?.bearer
        if let bearer = bearerToRevoke {
            let revokeURL = services.baseURL.appendingPathComponent("revoke")
            var req = URLRequest(url: revokeURL)
            req.httpMethod = "POST"
            req.timeoutInterval = 3
            req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
            req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            req.httpBody = "token=\(bearer)".data(using: .utf8)
            URLSession.shared.dataTask(with: req) { _, resp, err in
                if let err = err {
                    NSLog("[Taproot] /revoke fire-and-forget error: \(err.localizedDescription)")
                } else if let http = resp as? HTTPURLResponse, http.statusCode != 200 {
                    NSLog("[Taproot] /revoke returned HTTP \(http.statusCode)")
                } else {
                    NSLog("[Taproot] /revoke succeeded for workspace \(workspaceID.uuidString)")
                }
            }.resume()
        }

        do {
            try services.keychain.delete(workspaceID: workspaceID)
            mutateWorkspaces { $0.removeAll { $0.id == workspaceID } }
            pullCursors.removeValue(forKey: workspaceID)
            clearCursor(for: workspaceID)
            settingsStore.clearPausedOnLaunch(for: workspaceID)
            settingsStore.clearWorkspaceName(for: workspaceID)
            settingsStore.clearVaultFolder(for: workspaceID)
            NSLog("[Taproot] Signed out workspace \(workspaceID.uuidString)")
        } catch {
            NSLog("[Taproot] signOut failed: \(error)")
        }
    }

    /// Thin wrapper preserved for existing test surfaces + the 401 callback.
    /// Equivalent to `performSignOut`.
    func signOut(workspaceID: UUID) {
        performSignOut(workspaceID: workspaceID)
    }

    /// Reads pause-on-launch state from UserDefaults and marks any flagged
    /// workspaces `.paused` BEFORE `startAllWatchers`/`startAllPullPollers`
    /// run at launch. The early-return guards in `startWatcher` and
    /// `startPullPoller` then no-op for `.paused` workspaces, preserving
    /// the per-loaded-workspace start contract.
    func resumePausedFromUserDefaults() {
        let pausedIDs = workspaces
            .filter { settingsStore.isPausedOnLaunch(for: $0.id) }
            .map { $0.id }
        guard !pausedIDs.isEmpty else { return }
        mutateWorkspaces { wks in
            for id in pausedIDs {
                if let i = wks.firstIndex(where: { $0.id == id }) {
                    wks[i].syncStatus = .paused
                }
            }
        }
    }

    // MARK: - T11.5 menu construction

    /// Pure presentation: builds the menubar menu given the current workspaces.
    /// Internal access so tests can drive `[Workspace] -> NSMenu` without
    /// instantiating NSStatusBar / NSStatusItem (which is unavailable in
    /// headless XCTest). Side-effect-free.
    func buildMenu(for workspaces: [Workspace]) -> NSMenu {
        let menu = NSMenu()
        if workspaces.isEmpty {
            let signIn = NSMenuItem(
                title: "Sign in to Taproot…",
                action: #selector(menuSignIn(_:)),
                keyEquivalent: ""
            )
            signIn.target = self
            menu.addItem(signIn)
            let pair = NSMenuItem(
                title: "Pair with code…",
                action: #selector(menuEnterPairCode(_:)),
                keyEquivalent: ""
            )
            pair.target = self
            menu.addItem(pair)
            menu.addItem(.separator())
            let connectBrowser = NSMenuItem(
                title: "Connect via browser…",
                action: #selector(menuConnectAccount(_:)),
                keyEquivalent: ""
            )
            connectBrowser.target = self
            menu.addItem(connectBrowser)
            menu.addItem(.separator())
            appendCheckForUpdatesItem(to: menu)
            menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))
            return menu
        }
        if workspaces.count == 1 {
            // Flat layout: name acts as a section header above the actions.
            let nameLabel = NSMenuItem(title: workspaces[0].name, action: nil, keyEquivalent: "")
            nameLabel.isEnabled = false
            menu.addItem(nameLabel)
            appendActionItems(for: workspaces[0], to: menu)
            menu.addItem(.separator())
            appendCheckForUpdatesItem(to: menu)
            menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))
            return menu
        }
        // Nested layout: top-level row per workspace; actions live in submenu.
        for workspace in workspaces {
            let row = NSMenuItem(title: workspace.name, action: nil, keyEquivalent: "")
            let submenu = NSMenu()
            appendActionItems(for: workspace, to: submenu)
            row.submenu = submenu
            menu.addItem(row)
        }
        menu.addItem(.separator())
        appendCheckForUpdatesItem(to: menu)
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))
        return menu
    }

    private func appendCheckForUpdatesItem(to menu: NSMenu) {
        let item = NSMenuItem(
            title: "Check for updates…",
            action: #selector(menuCheckForUpdates(_:)),
            keyEquivalent: ""
        )
        item.target = self
        menu.addItem(item)
    }

    /// SF Symbol name for the menubar icon. Worst-status precedence:
    /// `.error > .syncing > .paused > .idle`. `[]` and all-idle render the
    /// default `leaf.fill`.
    func statusIconName(for workspaces: [Workspace]) -> String {
        if workspaces.contains(where: { if case .error = $0.syncStatus { return true } else { return false } }) {
            return "exclamationmark.triangle.fill"
        }
        if workspaces.contains(where: { $0.syncStatus == .syncing }) {
            return "arrow.triangle.2.circlepath"
        }
        if workspaces.contains(where: { $0.syncStatus == .paused }) {
            return "pause.fill"
        }
        return "leaf.fill"
    }

    /// Adds the 4 per-workspace action items (Open vault folder, Pause/Resume
    /// sync, Settings…, Sign out) plus an optional "Last error" row to `menu`.
    /// Used by both flat and nested layouts.
    private func appendActionItems(for workspace: Workspace, to menu: NSMenu) {
        let openFolder = NSMenuItem(
            title: "Open vault folder",
            action: #selector(menuOpenVaultFolder(_:)),
            keyEquivalent: ""
        )
        openFolder.target = self
        openFolder.representedObject = workspace.id
        menu.addItem(openFolder)

        let pauseTitle = workspace.syncStatus == .paused ? "Resume sync" : "Pause sync"
        let pauseSync = NSMenuItem(
            title: pauseTitle,
            action: #selector(menuTogglePauseSync(_:)),
            keyEquivalent: ""
        )
        pauseSync.target = self
        pauseSync.representedObject = workspace.id
        menu.addItem(pauseSync)

        let settings = NSMenuItem(
            title: "Settings…",
            action: #selector(menuOpenSettings(_:)),
            keyEquivalent: ""
        )
        settings.target = self
        // No representedObject — settings window is global, not per-workspace.
        menu.addItem(settings)

        let signOut = NSMenuItem(
            title: "Sign out",
            action: #selector(menuSignOut(_:)),
            keyEquivalent: ""
        )
        signOut.target = self
        signOut.representedObject = workspace.id
        menu.addItem(signOut)

        if case let .error(msg) = workspace.syncStatus {
            let errorItem = NSMenuItem(title: "Last error: \(msg)", action: nil, keyEquivalent: "")
            errorItem.isEnabled = false
            menu.addItem(errorItem)
        }
    }

    @objc func menuOpenVaultFolder(_ sender: NSMenuItem) {
        guard
            let id = sender.representedObject as? UUID,
            let workspace = workspaces.first(where: { $0.id == id })
        else { return }
        NSWorkspace.shared.open(workspace.localFolder)
    }

    @objc func menuTogglePauseSync(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? UUID else { return }
        togglePauseSync(workspaceID: id)
    }

    /// Pauses (or resumes) sync for one workspace by stopping/starting both
    /// the FSEvent watcher and the pull poller. `.paused` lives in-memory on
    /// `Workspace.syncStatus` — relaunch always resumes (no persistence at
    /// Stage 1; defer to T11.6 settings if/when needed).
    func togglePauseSync(workspaceID: UUID) {
        guard let i = workspaces.firstIndex(where: { $0.id == workspaceID }) else { return }
        if workspaces[i].syncStatus == .paused {
            // Resume. Flip syncStatus to .idle BEFORE starting so the
            // T11.6 `.paused` early-return guard in `startWatcher` /
            // `startPullPoller` doesn't fire on the resumed workspace.
            mutateWorkspaces { wks in
                if let j = wks.firstIndex(where: { $0.id == workspaceID }) {
                    wks[j].syncStatus = .idle
                }
            }
            startWatcher(for: workspaces[i])
            startPullPoller(for: workspaces[i])
            startHeartbeat(for: workspaces[i])
            settingsStore.clearPausedOnLaunch(for: workspaceID)
        } else {
            // Pause. Removing the dict entry lets startWatcher's idempotency
            // guard (`watchers[id] == nil`) pass on the next resume.
            watchers[workspaceID]?.stop()
            watchers.removeValue(forKey: workspaceID)
            stopPullPoller(for: workspaceID)
            stopHeartbeat(workspaceID: workspaceID)
            mutateWorkspaces { wks in
                if let j = wks.firstIndex(where: { $0.id == workspaceID }) {
                    wks[j].syncStatus = .paused
                }
            }
            settingsStore.setPausedOnLaunch(true, for: workspaceID)
        }
    }

    @objc func menuOpenSettings(_ sender: NSMenuItem) {
        presentSettings()
    }

    @objc func menuCheckForUpdates(_ sender: NSMenuItem) {
        updates.checkForUpdates()
    }

    @objc func menuSignOut(_ sender: NSMenuItem) {
        guard
            let id = sender.representedObject as? UUID,
            let workspace = workspaces.first(where: { $0.id == id })
        else { return }
        if confirmSignOut(workspace) {
            performSignOut(workspaceID: id)
        }
    }

    // MARK: - Watcher lifecycle

    /// Idempotent. Constructs a WorkspaceWatcher for the workspace and starts it.
    /// Early-returns if a watcher already exists for the workspace ID.
    func startWatcher(for workspace: Workspace) {
        guard watchers[workspace.id] == nil else { return }
        // T11.6: paused workspaces resumed from UserDefaults at launch must
        // not start a watcher. Resume path flips `.paused` → `.idle` BEFORE
        // calling `startWatcher` (see `togglePauseSync`), so this guard
        // only fires for the on-launch case.
        guard workspace.syncStatus != .paused else { return }
        let id = workspace.id
        let watcher = WorkspaceWatcher(
            workspaceID: id,
            folder: workspace.localFolder
        ) { [weak self] events in
            self?.handleFileChanges(workspaceID: id, events: events)
        }
        watcher.start()
        watchers[id] = watcher
    }

    /// Iterates `workspaces` and starts a watcher per workspace. Extracted from
    /// `applicationDidFinishLaunching` as a testable seam (tests can populate
    /// workspaces and call this without triggering full app launch / NSStatusItem).
    func startAllWatchers() {
        workspaces.forEach { startWatcher(for: $0) }
    }

    /// Routes batched file change events to `SyncEngine.push`. Internal access
    /// so tests can drive the wire-in directly without spinning up a real watcher.
    ///
    /// In-flight push during signOut is NOT cancelled. Idempotency analysis lives
    /// in the T11.3 plan §4: the 401-fired re-entrant `signOut` is safe because
    /// `KeychainStore.delete` tolerates `errSecItemNotFound`, watchers dict lookup
    /// is optional, and `workspaces.removeAll` no-ops on empty match.
    func handleFileChanges(workspaceID: UUID, events: [FileChangeEvent]) {
        NSLog("[Taproot] Watcher fired for \(workspaceID.uuidString): \(events.count) event(s)")
        guard let workspace = workspaces.first(where: { $0.id == workspaceID }) else {
            NSLog("[Taproot] Dropping events for unknown workspace \(workspaceID.uuidString)")
            return
        }
        let snapshot = WorkspaceSnapshot(
            id: workspace.id,
            bearer: workspace.bearer,
            localFolder: workspace.localFolder
        )
        mutateWorkspaces { wks in
            if let i = wks.firstIndex(where: { $0.id == workspaceID }) {
                wks[i].syncStatus = .syncing
            }
        }
        // Always-flip to .idle after push: SyncEngine.push is fire-and-forget
        // at Stage 1 (transport failures NSLog + drop). Surfacing them as
        // .error here would require a SyncEngine.push return-type change —
        // deferred per Decision 2.
        Task { @MainActor [weak self, syncEngine] in
            await syncEngine.push(workspace: snapshot, events: events)
            self?.mutateWorkspaces { wks in
                if let i = wks.firstIndex(where: { $0.id == workspaceID }) {
                    wks[i].syncStatus = .idle
                }
            }
        }
    }

    // MARK: - Pull poller lifecycle (T11.4)

    /// Idempotent. Spawns an unstructured Task that issues GET /api/sync/pull
    /// every `pullIntervalMs` until cancelled.
    func startPullPoller(for workspace: Workspace) {
        guard pullPollers[workspace.id] == nil else { return }
        // T11.6: same .paused on-launch guard as `startWatcher`.
        guard workspace.syncStatus != .paused else { return }
        let id = workspace.id
        let interval = pullIntervalMs
        pullPollers[id] = Task { [weak self] in
            // Initial tick on a tiny delay so AppDelegate finishes launching
            // before we hit the network.
            try? await Task.sleep(nanoseconds: 100_000_000)
            while !Task.isCancelled {
                await self?.pullTick(workspaceID: id)
                try? await Task.sleep(nanoseconds: interval * 1_000_000)
            }
        }
    }

    /// Iterates `workspaces` and starts a poller per workspace. Mirrors
    /// `startAllWatchers`'s testable-seam pattern.
    func startAllPullPollers() {
        workspaces.forEach { startPullPoller(for: $0) }
    }

    /// Iterates `workspaces` and starts a heartbeat per workspace.
    func startAllHeartbeats() {
        workspaces.forEach { startHeartbeat(for: $0) }
    }

    /// Idempotent.
    func stopPullPoller(for workspaceID: UUID) {
        pullPollers[workspaceID]?.cancel()
        pullPollers.removeValue(forKey: workspaceID)
    }

    /// Idempotent.
    func stopHeartbeat(workspaceID: UUID) {
        heartbeatTasks[workspaceID]?.cancel()
        heartbeatTasks.removeValue(forKey: workspaceID)
    }

    func startHeartbeat(for workspace: Workspace) {
        guard heartbeatTasks[workspace.id] == nil else { return }
        guard workspace.syncStatus != .paused else { return }
        let id = workspace.id
        heartbeatTasks[id] = Task { [weak self] in
            await self?.heartbeatTick(workspaceID: id)
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 120_000_000_000) // 2 minutes
                await self?.heartbeatTick(workspaceID: id)
            }
        }
    }

    func heartbeatTick(workspaceID: UUID) async {
        guard let ws = workspaces.first(where: { $0.id == workspaceID }) else { return }
        let url = services.baseURL.appendingPathComponent("api/helper/heartbeat")
        let req = HTTPRequest(
            url: url,
            method: "PUT",
            headers: [
                "Content-Type": "application/json",
                "Authorization": "Bearer \(ws.bearer)"
            ],
            body: Data()
        )
        _ = try? await services.httpClient.send(req)
    }

    /// One pull tick. Pauses watcher, drains up to `maxDrainPagesPerTick`
    /// pages from the server, persists the cursor, resumes the watcher.
    /// Internal access so tests can drive directly without spawning the
    /// background poller Task.
    func pullTick(workspaceID: UUID) async {
        guard let workspace = workspaces.first(where: { $0.id == workspaceID }) else { return }
        let snapshot = WorkspaceSnapshot(
            id: workspace.id,
            bearer: workspace.bearer,
            localFolder: workspace.localFolder
        )
        mutateWorkspaces { wks in
            if let i = wks.firstIndex(where: { $0.id == workspaceID }) {
                wks[i].syncStatus = .syncing
            }
        }
        let watcher = watchers[workspaceID]
        watcher?.stop()

        var cursor = pullCursors[workspaceID]
        var pageCount = 0
        var terminalStatus: SyncStatus = .idle
        drainLoop: while pageCount < Self.maxDrainPagesPerTick {
            let outcome = await syncEngine.pull(
                workspace: snapshot,
                cursor: cursor,
                applyWrite: { [weak self] target, content in
                    await self?.writeFileWithMkdir(at: target, content: content)
                },
                applyDelete: { [weak self] target in
                    await self?.deleteFileIfExists(at: target)
                }
            )
            pageCount += 1
            switch outcome {
            case .caughtUp(let next):
                if let next { cursor = next }
                break drainLoop
            case .morePages(let next):
                cursor = next
            case .transportError:
                // Cursor unchanged; bail out for this tick. Surface as error
                // so the menubar icon flips and the menu shows last-error.
                terminalStatus = .error("transport")
                break drainLoop
            }
        }

        if let cursor {
            pullCursors[workspaceID] = cursor
            persistCursor(cursor, for: workspaceID)
        }
        watcher?.start()

        mutateWorkspaces { wks in
            if let i = wks.firstIndex(where: { $0.id == workspaceID }) {
                wks[i].syncStatus = terminalStatus
            }
        }

        if pageCount >= Self.maxDrainPagesPerTick {
            NSLog("[Taproot] pullTick: hit D5 cap (\(Self.maxDrainPagesPerTick) pages); next tick will continue draining workspace \(workspaceID.uuidString)")
        }
    }

    private func writeFileWithMkdir(at target: URL, content: String) async {
        let dir = target.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try Data(content.utf8).write(to: target, options: .atomic)
        } catch {
            NSLog("[Taproot] pull: write failed for \(target.path): \(error)")
        }
    }

    private func deleteFileIfExists(at target: URL) async {
        let fm = FileManager.default
        guard fm.fileExists(atPath: target.path) else { return }
        do {
            try fm.removeItem(at: target)
        } catch {
            NSLog("[Taproot] pull: delete failed for \(target.path): \(error)")
        }
    }

    // MARK: - Cursor persistence (UserDefaults)

    /// Test seam matching `TAPROOT_BASE_URL` / `TAPROOT_KEYCHAIN_SERVICE` /
    /// `TAPROOT_LOCAL_FOLDER_BASE`: when set, both cursor + settings
    /// persistence route through `UserDefaults(suiteName:)` so the E2E
    /// smoke can read shipped state via `defaults read <suite> ...` without
    /// polluting the global domain. Inert in production unless set.
    private func taprootDefaults() -> UserDefaults {
        if let suite = ProcessInfo.processInfo.environment["TAPROOT_USERDEFAULTS_SUITE"],
           !suite.isEmpty,
           let suited = UserDefaults(suiteName: suite) {
            return suited
        }
        return .standard
    }

    private func cursorDefaults() -> UserDefaults { taprootDefaults() }

    private func persistCursor(_ cursor: PullCursor, for id: UUID) {
        let defaults = cursorDefaults()
        defaults.set(cursor.modifiedAt, forKey: "taproot.lastSync.\(id.uuidString)")
        defaults.set(cursor.id, forKey: "taproot.lastSyncId.\(id.uuidString)")
    }

    private func loadCursor(for id: UUID) -> PullCursor? {
        let defaults = cursorDefaults()
        guard
            let modifiedAt = defaults.string(forKey: "taproot.lastSync.\(id.uuidString)"),
            let cursorId = defaults.string(forKey: "taproot.lastSyncId.\(id.uuidString)"),
            !modifiedAt.isEmpty, !cursorId.isEmpty
        else {
            return nil
        }
        return PullCursor(modifiedAt: modifiedAt, id: cursorId)
    }

    private func clearCursor(for id: UUID) {
        let defaults = cursorDefaults()
        defaults.removeObject(forKey: "taproot.lastSync.\(id.uuidString)")
        defaults.removeObject(forKey: "taproot.lastSyncId.\(id.uuidString)")
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}
