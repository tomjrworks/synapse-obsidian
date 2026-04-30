import XCTest
import AppKit
@testable import TaprootHelper

@MainActor
final class FirstRunCoordinatorTests: XCTestCase {
    private var fake: FakeHTTPClient!
    private var firstRun: FirstRunCoordinator!
    private var cancelCalls: [UUID] = []
    private var confirmCalls: [(UUID, String, String, URL)] = []

    override func setUpWithError() throws {
        // Force NSApp init so wired defaults that touch NSApp.activate /
        // NSAlert / NSWorkspace don't crash under headless xctest.
        _ = NSApplication.shared
        fake = FakeHTTPClient()
        let services = Services(
            keychain: KeychainStore(service: "com.taproot.helper.tests.firstrun"),
            httpClient: fake,
            baseURL: URL(string: "http://localhost:0")!,
            now: { Date(timeIntervalSince1970: 0) }
        )
        cancelCalls = []
        confirmCalls = []
        firstRun = FirstRunCoordinator(
            services: services,
            onCancelFirstRun: { [weak self] id in
                self?.cancelCalls.append(id)
            },
            onConfirmFirstRun: { [weak self] id, bearer, name, url in
                self?.confirmCalls.append((id, bearer, name, url))
            },
            // Mirror the slug-based suffix from AppDelegate.defaultLocalFolder
            // so the slug-derivation assertion in
            // testPresentFirstRunFetchesNameThenConstructsWindow remains
            // meaningful.
            defaultLocalFolderProvider: { id, slug in
                let leaf = slug ?? id.uuidString
                return URL(fileURLWithPath: "/tmp/Taproot/\(leaf)")
            }
        )
    }

    private func meBodyJSON(workspaceName: String?, workspaceID: UUID) -> Data {
        var dict: [String: Any] = [
            "user_id": "u",
            "email": "e",
            "workspace_id": workspaceID.uuidString,
        ]
        if let name = workspaceName {
            dict["workspace_name"] = name
        }
        return try! JSONSerialization.data(withJSONObject: dict)
    }

    // MARK: - fetchWorkspaceName wiring

    func testFetchWorkspaceNameSendsAuthenticatedGetToApiMe() async throws {
        let id = UUID()
        await fake.setStubbedResponse(
            .success(HTTPResponse(status: 200, body: meBodyJSON(workspaceName: "My Vault", workspaceID: id)))
        )
        firstRun.wireDefaults()

        let result = await firstRun.fetchWorkspaceName(id, "B")

        switch result {
        case .success(let name):
            XCTAssertEqual(name, "My Vault")
        case .failure(let err):
            XCTFail("Expected success, got \(err)")
        }
        let lastRequest = await fake.lastRequest
        let req = try XCTUnwrap(lastRequest)
        XCTAssertTrue(
            req.url.absoluteString.hasSuffix("/api/me"),
            "Expected URL to end with /api/me, got \(req.url.absoluteString)"
        )
        XCTAssertEqual(req.method, "GET")
        XCTAssertEqual(req.headers["Authorization"], "Bearer B")
    }

    func testFetchWorkspaceNameMaps401ToUnauthorized() async {
        await fake.setStubbedResponse(.success(HTTPResponse(status: 401, body: Data())))
        firstRun.wireDefaults()

        let result = await firstRun.fetchWorkspaceName(UUID(), "B")

        if case .failure(let err) = result {
            XCTAssertEqual(err, .unauthorized)
        } else {
            XCTFail("Expected .failure(.unauthorized)")
        }
    }

    func testFetchWorkspaceNameMapsMissingFieldToDecodeFailed() async {
        let id = UUID()
        await fake.setStubbedResponse(
            .success(HTTPResponse(status: 200, body: meBodyJSON(workspaceName: nil, workspaceID: id)))
        )
        firstRun.wireDefaults()

        let result = await firstRun.fetchWorkspaceName(id, "B")

        if case .failure(let err) = result {
            XCTAssertEqual(err, .decodeFailed)
        } else {
            XCTFail("Expected .failure(.decodeFailed)")
        }
    }

    func testFetchWorkspaceNameTransportErrorMapsToTransport() async {
        await fake.setStubbedResponse(.failure(URLError(.notConnectedToInternet)))
        firstRun.wireDefaults()

        let result = await firstRun.fetchWorkspaceName(UUID(), "B")

        if case .failure(let err) = result {
            XCTAssertEqual(err, .transport)
        } else {
            XCTFail("Expected .failure(.transport)")
        }
    }

    // MARK: - presentFirstRun wiring

    func testPresentFirstRunFetchesNameThenConstructsWindow() async throws {
        let id = UUID()
        await fake.setStubbedResponse(
            .success(HTTPResponse(status: 200, body: meBodyJSON(workspaceName: "My Vault", workspaceID: id)))
        )
        firstRun.wireDefaults()

        var capturedName: String?
        var capturedDefaultURL: URL?
        let exp = expectation(description: "makeFirstRunWindow fired")
        firstRun.makeFirstRunWindow = { _, _, name, defaultURL, _, _ in
            capturedName = name
            capturedDefaultURL = defaultURL
            exp.fulfill()
            return NSWindowController()
        }

        firstRun.presentFirstRun(id, "B")
        await fulfillment(of: [exp], timeout: 2.0)

        XCTAssertEqual(capturedName, "My Vault")
        XCTAssertTrue(
            capturedDefaultURL?.path.hasSuffix("Taproot/my-vault") == true,
            "expected default folder slug, got \(capturedDefaultURL?.path ?? "nil")"
        )
    }

    func testPresentFirstRunOnFetchFailureCallsCancelAndShowsAlert() async throws {
        let id = UUID()
        firstRun.wireDefaults()
        // Override fetchWorkspaceName AFTER wiring (closure body looks up via
        // self.fetchWorkspaceName at call time, so override sticks).
        firstRun.fetchWorkspaceName = { _, _ in .failure(.unauthorized) }

        var capturedMsg: String?
        let exp = expectation(description: "alert shown")
        firstRun.presentFirstRunFailureAlert = { msg in
            capturedMsg = msg
            exp.fulfill()
        }

        firstRun.presentFirstRun(id, "B")
        await fulfillment(of: [exp], timeout: 2.0)

        XCTAssertEqual(capturedMsg, "Sign-in expired. Please try again.")
        XCTAssertEqual(cancelCalls, [id],
                       "fetch failure must call onCancelFirstRun so AppDelegate cleans Keychain + SettingsStore")
    }

    // MARK: - confirm path bridges

    func testWindowConfirmCallbackForwardsThroughOnConfirmBridge() async throws {
        let id = UUID()
        let pickedURL = URL(fileURLWithPath: "/tmp/picked")
        await fake.setStubbedResponse(
            .success(HTTPResponse(status: 200, body: meBodyJSON(workspaceName: "Vault", workspaceID: id)))
        )
        firstRun.wireDefaults()

        // Capture the onConfirm closure handed to the window factory, then
        // invoke it as the FirstRunWindowController would on Get-started.
        let confirmReady = expectation(description: "window factory fired")
        var capturedConfirm: ((UUID, String, URL) -> Void)?
        firstRun.makeFirstRunWindow = { _, _, _, _, _, onConfirm in
            capturedConfirm = onConfirm
            confirmReady.fulfill()
            return NSWindowController()
        }

        firstRun.presentFirstRun(id, "B")
        await fulfillment(of: [confirmReady], timeout: 2.0)

        let callback = try XCTUnwrap(capturedConfirm)
        callback(id, "B", pickedURL)

        XCTAssertEqual(confirmCalls.count, 1)
        XCTAssertEqual(confirmCalls.first?.0, id)
        XCTAssertEqual(confirmCalls.first?.1, "B")
        XCTAssertEqual(confirmCalls.first?.2, "Vault",
                       "Coordinator must forward the fetched workspace name, not let AppDelegate re-fetch")
        XCTAssertEqual(confirmCalls.first?.3, pickedURL)
    }

    func testWindowCancelCallbackForwardsThroughOnCancelBridge() async throws {
        let id = UUID()
        await fake.setStubbedResponse(
            .success(HTTPResponse(status: 200, body: meBodyJSON(workspaceName: "Vault", workspaceID: id)))
        )
        firstRun.wireDefaults()

        let cancelReady = expectation(description: "window factory fired")
        var capturedCancel: ((UUID) -> Void)?
        firstRun.makeFirstRunWindow = { _, _, _, _, onCancel, _ in
            capturedCancel = onCancel
            cancelReady.fulfill()
            return NSWindowController()
        }

        firstRun.presentFirstRun(id, "B")
        await fulfillment(of: [cancelReady], timeout: 2.0)

        let callback = try XCTUnwrap(capturedCancel)
        callback(id)

        XCTAssertEqual(cancelCalls, [id])
    }

    // MARK: - error message copy

    func testFirstRunErrorMessageCopy() {
        XCTAssertEqual(firstRun.firstRunErrorMessage(.unauthorized),
                       "Sign-in expired. Please try again.")
        XCTAssertEqual(firstRun.firstRunErrorMessage(.transport),
                       "Couldn't reach Taproot. Check your internet connection and try again.")
        XCTAssertEqual(firstRun.firstRunErrorMessage(.decodeFailed),
                       "Connection failed: server response missing workspace name.")
        XCTAssertEqual(firstRun.firstRunErrorMessage(.http(503)),
                       "Connection failed: server returned 503.")
        XCTAssertEqual(firstRun.firstRunErrorMessage(.notWired),
                       "Connection failed.")
    }
}
