import AppKit

/// Welcome window shown on first connect. The vault is now sourced from the
/// user's Obsidian config (B): the controller's `enterInitialState` reads
/// `obsidian.json` and either pre-selects a vault, gates on missing-Obsidian,
/// or polls for a brand-new install. The legacy single-default UX is preserved
/// as the fallback after a manual NSOpenPanel pick — that path still routes
/// through `applyChosenFolder`.
///
/// `init` does NOT auto-detect. Production wiring calls `enterInitialState()`
/// after construction (so seams can be overridden in tests). The pre-existing
/// public surface — `handleCancel`, `handleGetStarted`, `applyChosenFolder`,
/// `currentURL`, `isInConflict`, `isGetStartedEnabled`, `checkConflict` —
/// is unchanged.
@MainActor
final class FirstRunWindowController: NSWindowController, NSWindowDelegate {
    let workspaceID: UUID
    private let bearer: String
    private let workspaceName: String
    private let onCancel: (UUID) -> Void
    private let onConfirm: (UUID, String, URL) -> Void

    private var didFinish = false

    private(set) var currentURL: URL
    private(set) var isInConflict: Bool = false
    private(set) var isGetStartedEnabled: Bool = true
    /// §3a S1.2: true iff the chosen vault contains a `.obsidian/` marker.
    /// Get-started is gated on this in addition to `!isInConflict`.
    private(set) var hasObsidianMarker: Bool = true

    /// The picker's current top-level state. Drives which content view is
    /// rendered when `enterInitialState` runs.
    enum PickerState: Equatable {
        case obsidianNotInstalled
        case pickingFromList(vaults: [DetectedVault], selectedID: String?)
        case waitingForVaultCreation(elapsed: TimeInterval)
        case manualPickOnly
    }

    private(set) var pickerState: PickerState = .manualPickOnly

    // MARK: - test seams

    var checkConflict: (URL) -> Bool = { ObsidianSyncCheck.hasConflict(at: $0) }
    var resolver: () -> [DetectedVault] = { ObsidianVaultResolver.detect() }
    var isObsidianInstalled: () -> Bool = { ObsidianAppDetector.isInstalled() }
    var openObsidian: () -> Void = { ObsidianAppDetector.openObsidian() }
    var openDownloadPage: () -> Void = {
        if let url = URL(string: "https://obsidian.md/download") {
            NSWorkspace.shared.open(url)
        }
    }
    /// §3a S1.2 marker check. Default uses FileManager directly.
    var hasMarker: (URL) -> Bool = { url in
        var isDir: ObjCBool = false
        let exists = FileManager.default.fileExists(
            atPath: url.appendingPathComponent(".obsidian").path,
            isDirectory: &isDir
        )
        return exists && isDir.boolValue
    }
    /// Seam for the poll loop — production fires every 2s up to 5 min via Task.
    /// Tests inject a synchronous closure to drive transitions deterministically.
    var startPolling: ((@escaping () -> Void) -> Void)? = nil

    // MARK: - view refs

    private weak var pathLabel: NSTextField?
    private weak var conflictWarning: NSTextField?
    private weak var markerWarning: NSTextField?
    private weak var getStartedButton: NSButton?

    private var pollTask: Task<Void, Never>?

    init(workspaceID: UUID, bearer: String, workspaceName: String, defaultFolderURL: URL,
         onCancel: @escaping (UUID) -> Void,
         onConfirm: @escaping (UUID, String, URL) -> Void) {
        self.workspaceID = workspaceID
        self.bearer = bearer
        self.workspaceName = workspaceName
        // The defaultFolderURL parameter is retained for binary-compat with
        // FirstRunCoordinator's makeFirstRunWindow factory (Option A from the
        // workstream-B plan §6). It seeds `currentURL` so legacy public-API
        // callers that bypass `enterInitialState` still see a sensible value;
        // production rewrites this once auto-detect lands on a vault.
        self.currentURL = defaultFolderURL
        self.onCancel = onCancel
        self.onConfirm = onConfirm
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 540, height: 260),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Welcome to Taproot"
        window.center()
        super.init(window: window)
        window.delegate = self
        buildContentView()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    // MARK: - public API (preserved)

    func handleCancel() {
        didFinish = true
        pollTask?.cancel()
        onCancel(workspaceID)
        window?.close()
    }

    func handleGetStarted() {
        guard isGetStartedEnabled else { return }
        didFinish = true
        pollTask?.cancel()
        onConfirm(workspaceID, bearer, currentURL)
        window?.close()
    }

    func windowWillClose(_ notification: Notification) {
        pollTask?.cancel()
        if !didFinish {
            onCancel(workspaceID)
        }
    }

    func applyChosenFolder(_ url: URL) {
        applyChosenFolder(url, hasConflict: checkConflict(url))
    }

    func applyChosenFolder(_ url: URL, hasConflict: Bool) {
        currentURL = url
        isInConflict = hasConflict
        hasObsidianMarker = hasMarker(url)
        recomputeGetStartedEnabled()
        pathLabel?.stringValue = url.path
        conflictWarning?.isHidden = !hasConflict
        markerWarning?.isHidden = hasObsidianMarker
        getStartedButton?.isEnabled = isGetStartedEnabled
    }

    private func recomputeGetStartedEnabled() {
        isGetStartedEnabled = !isInConflict && hasObsidianMarker
    }

    // MARK: - state machine entry

    /// Runs the auto-detect logic and transitions to the appropriate state.
    /// Production calls this after construction; tests call it after
    /// overriding seams. Idempotent — calling twice re-enters from scratch
    /// (used by the "I've installed it" recheck button).
    func enterInitialState() {
        pollTask?.cancel()
        pollTask = nil

        guard isObsidianInstalled() else {
            transition(to: .obsidianNotInstalled)
            return
        }
        let detected = resolver()
        if detected.isEmpty {
            transition(to: .waitingForVaultCreation(elapsed: 0))
            beginPolling()
        } else {
            transition(to: .pickingFromList(vaults: detected, selectedID: detected.first?.id))
        }
    }

    /// Test entry point: drive a single poll tick.
    func pollTick(elapsed: TimeInterval) {
        if elapsed >= 300 {
            transition(to: .manualPickOnly)
            pollTask?.cancel()
            return
        }
        let detected = resolver()
        if !detected.isEmpty {
            pollTask?.cancel()
            transition(to: .pickingFromList(vaults: detected, selectedID: detected.first?.id))
        } else {
            transition(to: .waitingForVaultCreation(elapsed: elapsed))
        }
    }

    func selectVault(id: String) {
        guard case .pickingFromList(let vaults, _) = pickerState else { return }
        guard let v = vaults.first(where: { $0.id == id }) else { return }
        transition(to: .pickingFromList(vaults: vaults, selectedID: id))
        applyChosenFolder(v.path)
    }

    private func transition(to state: PickerState) {
        pickerState = state
        switch state {
        case .obsidianNotInstalled:
            isGetStartedEnabled = false
        case .pickingFromList(let vaults, let selectedID):
            if let id = selectedID, let v = vaults.first(where: { $0.id == id }) {
                applyChosenFolder(v.path)
            } else {
                isGetStartedEnabled = false
            }
        case .waitingForVaultCreation:
            isGetStartedEnabled = false
        case .manualPickOnly:
            // Get-started stays disabled until applyChosenFolder lands a real path.
            isGetStartedEnabled = false
        }
        rebuildContentView()
    }

    private func beginPolling() {
        if let custom = startPolling {
            custom { [weak self] in self?.pollTask?.cancel() }
            return
        }
        let started = Date()
        pollTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if Task.isCancelled { return }
                self?.pollTick(elapsed: Date().timeIntervalSince(started))
                if case .pickingFromList = self?.pickerState { return }
                if case .manualPickOnly = self?.pickerState { return }
            }
        }
    }

    // MARK: - view actions

    @objc private func cancelClicked(_ sender: NSButton) { handleCancel() }
    @objc private func getStartedClicked(_ sender: NSButton) { handleGetStarted() }
    @objc private func changeClicked(_ sender: NSButton) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = currentURL
        guard let window else { return }
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let picked = panel.url else { return }
            Task { @MainActor in self?.applyChosenFolder(picked) }
        }
    }
    @objc private func iveInstalledClicked(_ sender: NSButton) { enterInitialState() }
    @objc private func openObsidianClicked(_ sender: NSButton) { openObsidian() }
    @objc private func openDownloadClicked(_ sender: NSButton) { openDownloadPage() }
    @objc private func manualPickClicked(_ sender: NSButton) {
        transition(to: .manualPickOnly)
        changeClicked(sender)
    }
    @objc private func vaultRowSelected(_ sender: NSButton) {
        selectVault(id: sender.identifier?.rawValue ?? "")
    }

    // MARK: - view construction

    private func rebuildContentView() { buildContentView() }

    private func buildContentView() {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false

        let header = NSTextField(labelWithString: "Welcome to Taproot")
        header.font = .boldSystemFont(ofSize: 14)
        stack.addArrangedSubview(header)

        switch pickerState {
        case .obsidianNotInstalled:
            buildObsidianMissingState(into: stack)
        case .pickingFromList(let vaults, let selectedID):
            buildPickingFromListState(vaults: vaults, selectedID: selectedID, into: stack)
        case .waitingForVaultCreation(let elapsed):
            buildWaitingState(elapsed: elapsed, into: stack)
        case .manualPickOnly:
            buildManualPickState(into: stack)
        }

        let container = NSView()
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: container.bottomAnchor, constant: -24),
        ])
        window?.contentView = container
    }

    private func buildObsidianMissingState(into stack: NSStackView) {
        let body = NSTextField(wrappingLabelWithString:
            "Taproot saves your notes to your Obsidian vault. Install Obsidian, " +
            "then come back and click \"I've installed it\".")
        stack.addArrangedSubview(body)

        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelClicked(_:)))
        cancel.bezelStyle = .rounded
        let download = NSButton(title: "Open download page", target: self, action: #selector(openDownloadClicked(_:)))
        download.bezelStyle = .rounded
        let installed = NSButton(title: "I've installed it", target: self, action: #selector(iveInstalledClicked(_:)))
        installed.bezelStyle = .rounded
        installed.keyEquivalent = "\r"
        let row = NSStackView(views: [cancel, download, installed])
        row.spacing = 8
        stack.addArrangedSubview(row)
    }

    private func buildPickingFromListState(vaults: [DetectedVault], selectedID: String?, into stack: NSStackView) {
        let body = NSTextField(labelWithString: "Pick a vault to connect:")
        stack.addArrangedSubview(body)

        for v in vaults {
            let row = NSButton(radioButtonWithTitle: v.path.path, target: self, action: #selector(vaultRowSelected(_:)))
            row.identifier = NSUserInterfaceItemIdentifier(v.id)
            row.state = (v.id == selectedID) ? .on : .off
            // §3a S1.1: full-path label, no truncation. NSButton radio titles
            // wrap by default with multi-line behavior at this width.
            stack.addArrangedSubview(row)
        }

        let path = NSTextField(wrappingLabelWithString: currentURL.path)
        path.maximumNumberOfLines = 0
        path.lineBreakMode = .byCharWrapping
        pathLabel = path

        addCommonRows(into: stack, includeChange: true)
    }

    private func buildWaitingState(elapsed: TimeInterval, into stack: NSStackView) {
        let body = NSTextField(wrappingLabelWithString:
            "Open Obsidian and create a vault — Taproot will pick it up automatically.")
        stack.addArrangedSubview(body)

        let elapsedLabel = NSTextField(labelWithString:
            "Waiting… \(Int(elapsed))s / 5 min")
        elapsedLabel.textColor = .secondaryLabelColor
        stack.addArrangedSubview(elapsedLabel)

        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelClicked(_:)))
        cancel.bezelStyle = .rounded
        let openObs = NSButton(title: "Open Obsidian", target: self, action: #selector(openObsidianClicked(_:)))
        openObs.bezelStyle = .rounded
        let pickManual = NSButton(title: "Pick folder manually", target: self, action: #selector(manualPickClicked(_:)))
        pickManual.bezelStyle = .rounded
        let row = NSStackView(views: [cancel, openObs, pickManual])
        row.spacing = 8
        stack.addArrangedSubview(row)
    }

    private func buildManualPickState(into stack: NSStackView) {
        let body = NSTextField(wrappingLabelWithString:
            "Couldn't auto-detect an Obsidian vault. Pick the folder where Obsidian saved your vault.")
        stack.addArrangedSubview(body)

        let path = NSTextField(wrappingLabelWithString: currentURL.path)
        path.maximumNumberOfLines = 0
        path.lineBreakMode = .byCharWrapping
        stack.addArrangedSubview(path)
        pathLabel = path

        addCommonRows(into: stack, includeChange: true)
    }

    private func addCommonRows(into stack: NSStackView, includeChange: Bool) {
        let conflict = NSTextField(wrappingLabelWithString:
            "Obsidian Sync detected. Disable it or pick a different folder to avoid sync conflicts.")
        conflict.textColor = .systemRed
        conflict.isHidden = !isInConflict
        conflict.maximumNumberOfLines = 0
        stack.addArrangedSubview(conflict)
        conflictWarning = conflict

        let marker = NSTextField(wrappingLabelWithString:
            "This folder doesn't look like an Obsidian vault. Open it in Obsidian first, or pick another folder.")
        marker.textColor = .systemOrange
        marker.isHidden = hasObsidianMarker
        marker.maximumNumberOfLines = 0
        stack.addArrangedSubview(marker)
        markerWarning = marker

        let upload = NSTextField(wrappingLabelWithString:
            "Taproot will upload everything in this folder to your encrypted vault.")
        upload.maximumNumberOfLines = 0
        stack.addArrangedSubview(upload)

        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelClicked(_:)))
        cancel.bezelStyle = .rounded

        var rowViews: [NSView] = [cancel]
        if includeChange {
            let change = NSButton(title: "Choose another folder…", target: self, action: #selector(changeClicked(_:)))
            change.bezelStyle = .rounded
            rowViews.append(change)
        }
        let getStarted = NSButton(title: "Get started", target: self, action: #selector(getStartedClicked(_:)))
        getStarted.bezelStyle = .rounded
        getStarted.keyEquivalent = "\r"
        getStarted.isEnabled = isGetStartedEnabled
        rowViews.append(getStarted)

        let row = NSStackView(views: rowViews)
        row.spacing = 8
        stack.addArrangedSubview(row)
        getStartedButton = getStarted
    }
}
