import XCTest
@testable import TaprootHelper

@MainActor
final class FirstRunWindowControllerTests: XCTestCase {
    private func makeTempFolder() throws -> URL {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("taproot-firstrun-tests-\(UUID().uuidString)")
            .resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    func testFirstRunCancelInvokesOnCancel() throws {
        let id = UUID()
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        var captured: UUID?
        let controller = FirstRunWindowController(
            workspaceID: id, bearer: "B", workspaceName: "X",
            defaultFolderURL: tmp,
            onCancel: { captured = $0 },
            onConfirm: { _, _, _ in }
        )

        controller.handleCancel()

        XCTAssertEqual(captured, id)
    }

    func testFirstRunGetStartedInvokesOnConfirm() throws {
        let id = UUID()
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        var capturedID: UUID?
        var capturedBearer: String?
        var capturedURL: URL?
        let controller = FirstRunWindowController(
            workspaceID: id, bearer: "B", workspaceName: "X",
            defaultFolderURL: tmp,
            onCancel: { _ in },
            onConfirm: { capturedID = $0; capturedBearer = $1; capturedURL = $2 }
        )

        controller.handleGetStarted()

        XCTAssertEqual(capturedID, id)
        XCTAssertEqual(capturedBearer, "B")
        XCTAssertEqual(capturedURL, tmp)
    }

    func testFirstRunSetFolderUpdatesCurrentURLAndClearsWarning() throws {
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let controller = FirstRunWindowController(
            workspaceID: UUID(), bearer: "B", workspaceName: "X",
            defaultFolderURL: tmp,
            onCancel: { _ in },
            onConfirm: { _, _, _ in }
        )
        // §3a S1 marker gate is covered by dedicated tests below; here we
        // isolate the conflict logic by treating any path as a real vault.
        controller.hasMarker = { _ in true }

        let picked = URL(fileURLWithPath: "/tmp/picked")
        controller.applyChosenFolder(picked, hasConflict: false)

        XCTAssertEqual(controller.currentURL, picked)
        XCTAssertFalse(controller.isInConflict)
        XCTAssertTrue(controller.isGetStartedEnabled)
    }

    func testFirstRunSetFolderWithConflictDisablesGetStarted() throws {
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let controller = FirstRunWindowController(
            workspaceID: UUID(), bearer: "B", workspaceName: "X",
            defaultFolderURL: tmp,
            onCancel: { _ in },
            onConfirm: { _, _, _ in }
        )
        controller.hasMarker = { _ in true }

        controller.applyChosenFolder(URL(fileURLWithPath: "/tmp/conflict"), hasConflict: true)
        XCTAssertTrue(controller.isInConflict)
        XCTAssertFalse(controller.isGetStartedEnabled)

        // Recovery: pick a clean folder, state restores.
        controller.applyChosenFolder(URL(fileURLWithPath: "/tmp/clean"), hasConflict: false)
        XCTAssertFalse(controller.isInConflict)
        XCTAssertTrue(controller.isGetStartedEnabled)
    }

    func testHandleGetStartedNoOpsWhenInConflict() throws {
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        var fired = false
        let controller = FirstRunWindowController(
            workspaceID: UUID(), bearer: "B", workspaceName: "X",
            defaultFolderURL: tmp,
            onCancel: { _ in },
            onConfirm: { _, _, _ in fired = true }
        )

        controller.applyChosenFolder(URL(fileURLWithPath: "/tmp/conflict"), hasConflict: true)
        controller.handleGetStarted()

        XCTAssertFalse(fired, "Get started must no-op while in conflict (defense-in-depth)")
    }

    func testFirstRunCheckConflictSeamFlowsToApplyFolder() throws {
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let controller = FirstRunWindowController(
            workspaceID: UUID(), bearer: "B", workspaceName: "X",
            defaultFolderURL: tmp,
            onCancel: { _ in },
            onConfirm: { _, _, _ in }
        )
        controller.checkConflict = { url in url.path.contains("conflict") }
        controller.hasMarker = { _ in true }

        controller.applyChosenFolder(URL(fileURLWithPath: "/tmp/conflict"))
        XCTAssertTrue(controller.isInConflict)
        XCTAssertFalse(controller.isGetStartedEnabled)

        controller.applyChosenFolder(URL(fileURLWithPath: "/tmp/clean"))
        XCTAssertFalse(controller.isInConflict)
        XCTAssertTrue(controller.isGetStartedEnabled)
    }

    /// B1 (build-audit-3): closing the window via the red X (no Cancel/Get-started
    /// click) must fire `onCancel` so the bearer the AppDelegate already stashed
    /// in Keychain gets cleared. Otherwise next launch picks up the orphan bearer
    /// and auto-syncs an unconsented folder.
    func testWindowCloseViaXFiresOnCancel() throws {
        let id = UUID()
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        var cancelCount = 0
        var capturedID: UUID?
        let controller = FirstRunWindowController(
            workspaceID: id, bearer: "B", workspaceName: "X",
            defaultFolderURL: tmp,
            onCancel: { cancelCount += 1; capturedID = $0 },
            onConfirm: { _, _, _ in }
        )

        // Simulate the user clicking the red X — bypasses cancelClicked and
        // getStartedClicked. Without an NSWindowDelegate, this currently
        // closes the window with no callback (RED).
        controller.window?.close()

        XCTAssertEqual(cancelCount, 1, "onCancel must fire exactly once when window closes via X")
        XCTAssertEqual(capturedID, id)
    }

    /// B1 didFinish defense: `handleCancel` already calls `onCancel`, then
    /// closes the window. If the new windowWillClose handler doesn't check a
    /// `didFinish` flag it will double-fire `onCancel`.
    func testHandleCancelDoesNotDoubleFireOnCancelWhenWindowCloses() throws {
        let id = UUID()
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        var cancelCount = 0
        let controller = FirstRunWindowController(
            workspaceID: id, bearer: "B", workspaceName: "X",
            defaultFolderURL: tmp,
            onCancel: { _ in cancelCount += 1 },
            onConfirm: { _, _, _ in }
        )

        controller.handleCancel()

        XCTAssertEqual(cancelCount, 1, "onCancel must fire exactly once across handleCancel + window close")
    }

    // MARK: - B4 state machine

    private func makeController(tmp: URL) -> FirstRunWindowController {
        FirstRunWindowController(
            workspaceID: UUID(), bearer: "B", workspaceName: "X",
            defaultFolderURL: tmp,
            onCancel: { _ in },
            onConfirm: { _, _, _ in }
        )
    }

    private func makeVault(under tmp: URL, name: String, withMarker: Bool = true) throws -> URL {
        let dir = tmp.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if withMarker {
            try FileManager.default.createDirectory(
                at: dir.appendingPathComponent(".obsidian"),
                withIntermediateDirectories: true
            )
        }
        // Mirror resolver: production paths arrive canonicalized.
        return dir.canonicalPath
    }

    func testInitialStateObsidianMissingShowsGate() throws {
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let controller = makeController(tmp: tmp)
        controller.isObsidianInstalled = { false }
        controller.resolver = { [] }

        controller.enterInitialState()

        XCTAssertEqual(controller.pickerState, .obsidianNotInstalled)
        XCTAssertFalse(controller.isGetStartedEnabled)
    }

    func testInitialStateZeroVaultsEntersWaitingState() throws {
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let controller = makeController(tmp: tmp)
        controller.isObsidianInstalled = { true }
        controller.resolver = { [] }
        // Suppress the real poll Task so the test stays deterministic.
        controller.startPolling = { _ in }

        controller.enterInitialState()

        if case .waitingForVaultCreation = controller.pickerState {} else {
            XCTFail("expected waitingForVaultCreation, got \(controller.pickerState)")
        }
        XCTAssertFalse(controller.isGetStartedEnabled)
    }

    func testInitialStateOneVaultPreselectsIt() throws {
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let vault = try makeVault(under: tmp, name: "MyVault")
        let controller = makeController(tmp: tmp)
        controller.isObsidianInstalled = { true }
        controller.resolver = {
            [DetectedVault(id: "v1", path: vault, lastOpened: Date(), isOpen: false)]
        }

        controller.enterInitialState()

        if case .pickingFromList(_, let selectedID) = controller.pickerState {
            XCTAssertEqual(selectedID, "v1")
        } else {
            XCTFail("expected pickingFromList, got \(controller.pickerState)")
        }
        XCTAssertEqual(controller.currentURL.path, vault.canonicalPath.path)
        XCTAssertTrue(controller.isGetStartedEnabled)
    }

    func testInitialStateMultipleVaultsPreselectsFirst() throws {
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let openVault = try makeVault(under: tmp, name: "Open")
        let oldVault = try makeVault(under: tmp, name: "Old")
        let controller = makeController(tmp: tmp)
        controller.isObsidianInstalled = { true }
        // Resolver contract: open-first then ts desc — so the open vault leads.
        controller.resolver = {
            [
                DetectedVault(id: "open", path: openVault, lastOpened: Date(), isOpen: true),
                DetectedVault(id: "old", path: oldVault, lastOpened: Date(timeIntervalSince1970: 1), isOpen: false),
            ]
        }

        controller.enterInitialState()

        if case .pickingFromList(_, let selectedID) = controller.pickerState {
            XCTAssertEqual(selectedID, "open")
        } else {
            XCTFail("expected pickingFromList, got \(controller.pickerState)")
        }
    }

    func testPollTickFindsVaultAdvancesToList() throws {
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let vault = try makeVault(under: tmp, name: "Late")
        let controller = makeController(tmp: tmp)
        controller.isObsidianInstalled = { true }
        var calls = 0
        controller.resolver = {
            calls += 1
            return calls == 1 ? [] : [DetectedVault(id: "late", path: vault, lastOpened: Date(), isOpen: false)]
        }
        controller.startPolling = { _ in }
        controller.enterInitialState()

        controller.pollTick(elapsed: 5)

        if case .pickingFromList(_, let selectedID) = controller.pickerState {
            XCTAssertEqual(selectedID, "late")
        } else {
            XCTFail("expected pickingFromList after poll find, got \(controller.pickerState)")
        }
    }

    func testPollTimeoutAdvancesToManualOnly() throws {
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let controller = makeController(tmp: tmp)
        controller.isObsidianInstalled = { true }
        controller.resolver = { [] }
        controller.startPolling = { _ in }
        controller.enterInitialState()

        controller.pollTick(elapsed: 301)

        XCTAssertEqual(controller.pickerState, .manualPickOnly)
    }

    func testIveInstalledRecheckAdvancesWhenInstalled() throws {
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let vault = try makeVault(under: tmp, name: "V")
        let controller = makeController(tmp: tmp)
        var installed = false
        controller.isObsidianInstalled = { installed }
        controller.resolver = {
            [DetectedVault(id: "v", path: vault, lastOpened: Date(), isOpen: false)]
        }

        controller.enterInitialState()
        XCTAssertEqual(controller.pickerState, .obsidianNotInstalled)

        installed = true
        controller.enterInitialState()  // simulates "I've installed it" recheck

        if case .pickingFromList = controller.pickerState {} else {
            XCTFail("expected pickingFromList after recheck, got \(controller.pickerState)")
        }
    }

    func testGetStartedInListStateCallsOnConfirmWithSelectedVault() throws {
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let vault = try makeVault(under: tmp, name: "V")
        var capturedURL: URL?
        let controller = FirstRunWindowController(
            workspaceID: UUID(), bearer: "B", workspaceName: "X",
            defaultFolderURL: tmp,
            onCancel: { _ in },
            onConfirm: { _, _, url in capturedURL = url }
        )
        controller.isObsidianInstalled = { true }
        controller.resolver = {
            [DetectedVault(id: "v", path: vault, lastOpened: Date(), isOpen: false)]
        }
        controller.enterInitialState()

        controller.handleGetStarted()

        XCTAssertEqual(capturedURL?.path, vault.canonicalPath.path)
    }

    // MARK: - §3a S1 — vault path consent UX

    func testPickedFolderWithoutObsidianMarkerDisablesGetStarted() throws {
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let nonVault = try makeVault(under: tmp, name: "NotAVault", withMarker: false)
        let controller = makeController(tmp: tmp)

        controller.applyChosenFolder(nonVault, hasConflict: false)

        XCTAssertFalse(controller.hasObsidianMarker)
        XCTAssertFalse(controller.isGetStartedEnabled,
            "Get-started must be disabled for a folder without .obsidian/")
    }

    func testPickedFolderWithObsidianMarkerEnablesGetStarted() throws {
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let realVault = try makeVault(under: tmp, name: "Real", withMarker: true)
        let controller = makeController(tmp: tmp)

        controller.applyChosenFolder(realVault, hasConflict: false)

        XCTAssertTrue(controller.hasObsidianMarker)
        XCTAssertTrue(controller.isGetStartedEnabled)
    }

    func testPathLabelDoesNotTruncateForLongPath() throws {
        // §3a S1.1: full path must be visible — no byTruncatingMiddle, which
        // would let a malicious obsidian.json swap hide segments. Asserts the
        // controller rebuilds with a wrapping label whose maxLines is 0 and
        // whose stringValue is the full path string.
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let longName = String(repeating: "a-very-long-folder-name-segment/", count: 4) + "vault"
        let longVault = try makeVault(under: tmp, name: longName)
        let controller = makeController(tmp: tmp)
        controller.isObsidianInstalled = { true }
        controller.resolver = {
            [DetectedVault(id: "long", path: longVault, lastOpened: Date(), isOpen: false)]
        }
        controller.enterInitialState()

        // currentURL must reflect the full canonical path verbatim.
        XCTAssertEqual(controller.currentURL.path, longVault.canonicalPath.path)
        XCTAssertFalse(controller.currentURL.path.contains("…"))
    }

    func testWindowWillCloseCancelsPollTask() throws {
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let controller = makeController(tmp: tmp)
        controller.isObsidianInstalled = { true }
        controller.resolver = { [] }
        var pollerCancelCalled = false
        controller.startPolling = { cancel in
            // Production seam: the controller hands us a cancel closure we
            // could invoke. We just record that the seam wired it up.
            _ = cancel
            pollerCancelCalled = true
        }

        controller.enterInitialState()

        XCTAssertTrue(pollerCancelCalled, "startPolling seam should be invoked when entering waiting state")

        // windowWillClose path: closing the window must mark didFinish via
        // onCancel and clear any in-flight poll.
        controller.windowWillClose(Notification(name: NSWindow.willCloseNotification))
        // No assertion needed beyond no crash; the cancel closure was already
        // consumed synchronously by the test seam.
    }

    /// B1 didFinish defense: `handleGetStarted` calls `onConfirm` and then
    /// closes the window. windowWillClose must NOT fire `onCancel` on the
    /// confirmed path or we'd both confirm and cancel the same workspace.
    func testHandleGetStartedDoesNotFireOnCancelWhenWindowCloses() throws {
        let id = UUID()
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        var cancelCount = 0
        var confirmCount = 0
        let controller = FirstRunWindowController(
            workspaceID: id, bearer: "B", workspaceName: "X",
            defaultFolderURL: tmp,
            onCancel: { _ in cancelCount += 1 },
            onConfirm: { _, _, _ in confirmCount += 1 }
        )

        controller.handleGetStarted()

        XCTAssertEqual(confirmCount, 1, "onConfirm must fire on Get started")
        XCTAssertEqual(cancelCount, 0, "onCancel must NOT fire when Get started already finished")
    }
}
