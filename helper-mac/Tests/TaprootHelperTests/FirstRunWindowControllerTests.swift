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
