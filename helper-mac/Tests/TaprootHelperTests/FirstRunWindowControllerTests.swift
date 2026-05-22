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

    private func makeVault(under tmp: URL, name: String, withMarker: Bool = true) throws -> URL {
        let dir = tmp.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if withMarker {
            try FileManager.default.createDirectory(
                at: dir.appendingPathComponent(".obsidian"),
                withIntermediateDirectories: true
            )
        }
        return dir.canonicalPath
    }

    private func makeController(tmp: URL) -> FirstRunWindowController {
        FirstRunWindowController(
            workspaceID: UUID(), bearer: "B", workspaceName: "X",
            defaultFolderURL: tmp,
            onCancel: { _ in },
            onConfirm: { _, _, _ in }
        )
    }

    // MARK: - lifecycle (cancel + confirm)

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

    // MARK: - applyChosenFolder + conflict + marker gating

    func testFirstRunSetFolderUpdatesCurrentURLAndClearsWarning() throws {
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let controller = makeController(tmp: tmp)
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
        let controller = makeController(tmp: tmp)
        controller.hasMarker = { _ in true }

        controller.applyChosenFolder(URL(fileURLWithPath: "/tmp/conflict"), hasConflict: true)
        XCTAssertTrue(controller.isInConflict)
        XCTAssertFalse(controller.isGetStartedEnabled)

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
        let controller = makeController(tmp: tmp)
        controller.checkConflict = { url in url.path.contains("conflict") }
        controller.hasMarker = { _ in true }

        controller.applyChosenFolder(URL(fileURLWithPath: "/tmp/conflict"))
        XCTAssertTrue(controller.isInConflict)
        XCTAssertFalse(controller.isGetStartedEnabled)

        controller.applyChosenFolder(URL(fileURLWithPath: "/tmp/clean"))
        XCTAssertFalse(controller.isInConflict)
        XCTAssertTrue(controller.isGetStartedEnabled)
    }

    // MARK: - window-close / didFinish defense

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

        controller.window?.close()

        XCTAssertEqual(cancelCount, 1, "onCancel must fire exactly once when window closes via X")
        XCTAssertEqual(capturedID, id)
    }

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

    // MARK: - 0.2.2 sandbox: two-state picker (obsidianNotInstalled + manualPickOnly)

    /// Obsidian not installed → gate on installing. Get-started disabled,
    /// state advertised as `.obsidianNotInstalled` so the menubar/UI can
    /// render the install-Obsidian flow.
    func testInitialStateObsidianMissingShowsGate() throws {
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let controller = makeController(tmp: tmp)
        controller.isObsidianInstalled = { false }

        controller.enterInitialState()

        XCTAssertEqual(controller.pickerState, .obsidianNotInstalled)
        XCTAssertFalse(controller.isGetStartedEnabled)
    }

    /// 0.2.2 sandbox rewrite: Obsidian installed → enter manual-pick mode
    /// directly. No polling / auto-detect / 5-min waiting label. Get Started
    /// stays disabled until the user picks a real vault.
    func testInitialStateObsidianInstalledEntersManualPickOnly() throws {
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let controller = makeController(tmp: tmp)
        controller.isObsidianInstalled = { true }

        controller.enterInitialState()

        XCTAssertEqual(controller.pickerState, .manualPickOnly)
        XCTAssertFalse(controller.isGetStartedEnabled,
                       "Manual-pick start state must keep Get Started disabled until a folder is picked")
    }

    /// "I've installed it" recheck button = re-enter initial state. When
    /// install gate flips from false to true, the controller moves to
    /// `.manualPickOnly` (no resolver, no auto-pick).
    func testIveInstalledRecheckAdvancesWhenInstalled() throws {
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let controller = makeController(tmp: tmp)
        var installed = false
        controller.isObsidianInstalled = { installed }

        controller.enterInitialState()
        XCTAssertEqual(controller.pickerState, .obsidianNotInstalled)

        installed = true
        controller.enterInitialState()

        XCTAssertEqual(controller.pickerState, .manualPickOnly,
                       "Recheck after install must enter manual-pick (no resolver in 0.2.2)")
    }

    // MARK: - §3a S1 marker gating

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

    /// §3a S1.1: full picked path is preserved (no truncation). The view-level
    /// invariant is enforced via `applyChosenFolder` writing the full path
    /// string to currentURL; rendering uses a wrapping label with no
    /// truncation.
    func testPickedPathPreservedVerbatimForLongFolder() throws {
        let tmp = try makeTempFolder()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let longName = String(repeating: "a-very-long-folder-name-segment/", count: 4) + "vault"
        let longVault = try makeVault(under: tmp, name: longName)
        let controller = makeController(tmp: tmp)

        controller.applyChosenFolder(longVault, hasConflict: false)

        XCTAssertEqual(controller.currentURL.path, longVault.canonicalPath.path)
        XCTAssertFalse(controller.currentURL.path.contains("…"))
    }
}
