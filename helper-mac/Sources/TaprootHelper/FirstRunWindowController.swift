import AppKit

/// Welcome window shown on first connect.
///
/// 0.2.2 sandbox rewrite: the auto-detect / poll-for-vault-creation flow
/// (read `obsidian.json` to pre-select a known vault) is retired. The App
/// Sandbox blocks reads of `~/Library/Application Support/obsidian/` without
/// either an XPC service or a user-granted NSOpenPanel pre-flight, both
/// multi-day projects. For 0.2.2 the picker has exactly two top-level
/// states: "Obsidian not installed" (gate the flow) and "Manual pick only"
/// (NSOpenPanel for the vault folder). The user-pick path stays the same
/// — `applyChosenFolder` validates the `.obsidian/` marker + conflict
/// check, and Get Started fires `onConfirm` with the picked URL.
///
/// `init` does NOT call the install-check. Production wiring calls
/// `enterInitialState()` after construction (so seams can be overridden in
/// tests). The public surface — `handleCancel`, `handleGetStarted`,
/// `applyChosenFolder`, `currentURL`, `isInConflict`, `isGetStartedEnabled`,
/// `checkConflict` — is unchanged.
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

    /// Phase 1 (0.1.5): live progress for the initial-sync run that AppDelegate
    /// kicks off after Get-Started. nil until the first progress callback
    /// fires; ".completed" means AppDelegate is about to dismiss the window;
    /// ".failed" surfaces a retry button.
    private(set) var initialSyncProgress: InitialSyncCoordinator.Progress?

    /// The picker's current top-level state. Drives which content view is
    /// rendered when `enterInitialState` runs. 0.2.2 sandbox: two states only.
    enum PickerState: Equatable {
        case obsidianNotInstalled
        case manualPickOnly
    }

    private(set) var pickerState: PickerState = .manualPickOnly

    // MARK: - test seams

    var checkConflict: (URL) -> Bool = { ObsidianSyncCheck.hasConflict(at: $0) }
    var isObsidianInstalled: () -> Bool = { ObsidianAppDetector.isInstalled() }
    var openObsidian: (URL?) -> Void = { ObsidianAppDetector.openObsidian(at: $0) }
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

    // MARK: - view refs

    private weak var pathLabel: NSTextField?
    private weak var conflictWarning: NSTextField?
    private weak var markerWarning: NSTextField?
    private weak var getStartedButton: NSButton?

    init(workspaceID: UUID, bearer: String, workspaceName: String, defaultFolderURL: URL,
         onCancel: @escaping (UUID) -> Void,
         onConfirm: @escaping (UUID, String, URL) -> Void) {
        self.workspaceID = workspaceID
        self.bearer = bearer
        self.workspaceName = workspaceName
        // The defaultFolderURL parameter is retained for binary-compat with
        // FirstRunCoordinator's makeFirstRunWindow factory. It seeds
        // `currentURL` as a cosmetic initial value for the pathLabel; the
        // user MUST pick a real vault via NSOpenPanel before Get Started
        // enables (transition(to: .manualPickOnly) sets isGetStartedEnabled
        // = false; applyChosenFolder re-enables it only after a successful
        // marker + conflict check).
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
        onCancel(workspaceID)
        window?.close()
    }

    func handleGetStarted() {
        guard isGetStartedEnabled else { return }
        guard !isSyncing else { return }
        // Do NOT set didFinish or close the window yet. AppDelegate runs the
        // initial sync via a Task and calls back with progress; on success it
        // calls `dismissAfterInitialSync()` which sets didFinish + closes the
        // window. If the user closes the window during sync, didFinish stays
        // false and `windowWillClose` fires `onCancel` so AppDelegate can
        // unwind the partially-paired workspace.
        //
        // Seed an indeterminate ".walking" progress so the UI flips into the
        // sync state immediately — otherwise there's a perceptible blank
        // window between click and the first real progress callback.
        initialSyncProgress = .init(synced: 0, total: 0, phase: .walking)
        rebuildContentView()
        onConfirm(workspaceID, bearer, currentURL)
    }

    var isSyncing: Bool {
        guard let p = initialSyncProgress else { return false }
        switch p.phase {
        case .walking, .pushing: return true
        case .completed, .failed: return false
        }
    }

    var showsInitialSyncRetry: Bool {
        guard let p = initialSyncProgress else { return false }
        if case .failed = p.phase { return true }
        return false
    }

    func setInitialSyncProgress(_ progress: InitialSyncCoordinator.Progress) {
        initialSyncProgress = progress
        rebuildContentView()
    }

    func dismissAfterInitialSync() {
        didFinish = true
        window?.close()
    }

    @objc func handleRetryInitialSync() {
        guard showsInitialSyncRetry else { return }
        initialSyncProgress = .init(synced: 0, total: 0, phase: .walking)
        rebuildContentView()
        onConfirm(workspaceID, bearer, currentURL)
    }

    func windowWillClose(_ notification: Notification) {
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

    /// Drops into the install-gated picker. Production calls this after
    /// construction; tests call it after overriding seams. Idempotent —
    /// calling twice re-enters from scratch (used by the "I've installed it"
    /// recheck button).
    ///
    /// 0.2.2 sandbox: no polling, no resolver. If Obsidian isn't installed
    /// the user gates on installing it; otherwise the picker is immediately
    /// in manual-pick mode and waits for an NSOpenPanel selection.
    func enterInitialState() {
        guard isObsidianInstalled() else {
            transition(to: .obsidianNotInstalled)
            return
        }
        transition(to: .manualPickOnly)
    }

    private func transition(to state: PickerState) {
        pickerState = state
        switch state {
        case .obsidianNotInstalled:
            isGetStartedEnabled = false
        case .manualPickOnly:
            // Get-started stays disabled until applyChosenFolder lands a real path.
            isGetStartedEnabled = false
        }
        rebuildContentView()
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
    @objc private func openObsidianClicked(_ sender: NSButton) { openObsidian(nil) }
    @objc private func openDownloadClicked(_ sender: NSButton) { openDownloadPage() }
    @objc private func retryClicked(_ sender: NSButton) { handleRetryInitialSync() }

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

        // Phase 1: once the user has clicked Get-Started, the window is
        // dedicated to the initial-sync progress UI. The picker state is
        // frozen at that point.
        if let progress = initialSyncProgress {
            buildInitialSyncState(progress: progress, into: stack)
            let container = NSView()
            container.addSubview(stack)
            NSLayoutConstraint.activate([
                stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 24),
                stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -24),
                stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 24),
                stack.bottomAnchor.constraint(lessThanOrEqualTo: container.bottomAnchor, constant: -24),
            ])
            window?.contentView = container
            return
        }

        switch pickerState {
        case .obsidianNotInstalled:
            buildObsidianMissingState(into: stack)
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

    private func buildInitialSyncState(progress: InitialSyncCoordinator.Progress, into stack: NSStackView) {
        let title: String
        switch progress.phase {
        case .walking:   title = "Scanning your vault…"
        case .pushing:   title = "Syncing your vault to the cloud"
        case .completed: title = "All set — \(progress.total) files synced"
        case .failed:    title = "Couldn't finish syncing your vault"
        }
        let titleLabel = NSTextField(wrappingLabelWithString: title)
        titleLabel.maximumNumberOfLines = 0
        stack.addArrangedSubview(titleLabel)

        let bar = NSProgressIndicator()
        bar.style = .bar
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.widthAnchor.constraint(equalToConstant: 480).isActive = true
        switch progress.phase {
        case .walking:
            bar.isIndeterminate = true
            bar.startAnimation(nil)
        case .pushing:
            bar.isIndeterminate = false
            bar.minValue = 0
            bar.maxValue = Double(max(progress.total, 1))
            bar.doubleValue = Double(progress.synced)
        case .completed:
            bar.isIndeterminate = false
            bar.minValue = 0
            bar.maxValue = Double(max(progress.total, 1))
            bar.doubleValue = Double(max(progress.total, 1))
        case .failed:
            bar.isIndeterminate = false
            bar.minValue = 0
            bar.maxValue = 1
            bar.doubleValue = 0
        }
        stack.addArrangedSubview(bar)

        let counter: String
        switch progress.phase {
        case .walking:
            counter = "Looking through your vault…"
        case .pushing:
            counter = "\(progress.synced) / \(progress.total) files"
        case .completed:
            counter = "Finishing up…"
        case .failed(let msg):
            counter = "Sync failed: \(msg)"
        }
        let counterLabel = NSTextField(wrappingLabelWithString: counter)
        counterLabel.textColor = .secondaryLabelColor
        counterLabel.maximumNumberOfLines = 0
        stack.addArrangedSubview(counterLabel)

        if showsInitialSyncRetry {
            let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelClicked(_:)))
            cancel.bezelStyle = .rounded
            let retry = NSButton(title: "Retry sync", target: self, action: #selector(retryClicked(_:)))
            retry.bezelStyle = .rounded
            retry.keyEquivalent = "\r"
            let row = NSStackView(views: [cancel, retry])
            row.spacing = 8
            stack.addArrangedSubview(row)
        }
    }

    private func buildManualPickState(into stack: NSStackView) {
        let body = NSTextField(wrappingLabelWithString:
            "Pick the folder where Obsidian saves your vault.")
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
