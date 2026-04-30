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
}
