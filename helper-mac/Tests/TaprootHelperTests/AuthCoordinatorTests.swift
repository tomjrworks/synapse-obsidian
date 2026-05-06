import XCTest
import AppKit
@testable import TaprootHelper

@MainActor
final class AuthCoordinatorTests: XCTestCase {
    private var fakeAuth: FakeAuthService!
    private var coord: AuthCoordinator!
    private var authSucceededCalls: [(UUID, String)] = []
    private var cancelCount = 0
    /// Captured directly from `makeAuthWindow` — avoids scanning `NSApp.windows`
    /// which is unreliable under headless xctest (window state leaks between tests).
    private var capturedAuthWindow: AuthWindowController?

    private let testWorkspaceID = UUID()
    private let testBearer = "device-bearer-" + String(repeating: "0", count: 18)

    override func setUpWithError() throws {
        _ = NSApplication.shared
        authSucceededCalls = []
        cancelCount = 0
        capturedAuthWindow = nil
        fakeAuth = FakeAuthService(workspaceID: testWorkspaceID, bearer: testBearer)
        let services = Services(
            keychain: KeychainStore(service: "com.taproot.helper.tests.auth"),
            httpClient: FakeHTTPClient(),
            baseURL: URL(string: "http://localhost:0")!,
            now: { Date(timeIntervalSince1970: 0) },
            auth: fakeAuth
        )
        coord = AuthCoordinator(
            services: services,
            onAuthSucceeded: { [weak self] wsID, bearer in
                self?.authSucceededCalls.append((wsID, bearer))
            },
            onCancel: { [weak self] in
                self?.cancelCount += 1
            }
        )
        wireTestWindow()
    }

    override func tearDownWithError() throws {
        capturedAuthWindow?.window?.close()
        capturedAuthWindow = nil
        coord = nil
        fakeAuth = nil
    }

    /// Injects a `makeAuthWindow` closure that captures the created `AuthWindowController`
    /// directly, avoiding the `NSApp.windows` scan which is unreliable in headless mode.
    private func wireTestWindow() {
        coord.makeAuthWindow = { [weak self] onSubmit, onCancel, onSignUp in
            let ctrl = AuthWindowController(
                onSubmit: onSubmit,
                onCancel: onCancel,
                onSignUpRequested: onSignUp
            )
            self?.capturedAuthWindow = ctrl
            return ctrl
        }
        coord.openSignUpURL = { }
        coord.presentTransientErrorAlert = { _ in }
        coord.deviceName = { "test-host" }
        coord.osPlatform = { "darwin" }
    }

    // MARK: - Happy path

    func testHappyPathCallsOnAuthSucceeded() async {
        coord.presentSignIn()
        guard let authWin = capturedAuthWindow else {
            return XCTFail("Expected AuthWindowController to be captured")
        }
        authWin.emailField?.stringValue = "alice@example.com"
        authWin.passwordField?.stringValue = "hunter2"
        authWin.handleSubmit()

        try? await Task.sleep(nanoseconds: 200_000_000)

        XCTAssertEqual(authSucceededCalls.count, 1)
        XCTAssertEqual(authSucceededCalls.first?.0, testWorkspaceID)
        XCTAssertEqual(authSucceededCalls.first?.1, testBearer)
    }

    func testHappyPathPassesEmailAndPasswordToService() async {
        coord.presentSignIn()
        guard let authWin = capturedAuthWindow else { return XCTFail("No auth window") }
        authWin.emailField?.stringValue = "bob@example.com"
        authWin.passwordField?.stringValue = "secret123"
        authWin.handleSubmit()

        try? await Task.sleep(nanoseconds: 200_000_000)

        let email = await fakeAuth.lastSignInEmail
        let password = await fakeAuth.lastSignInPassword
        XCTAssertEqual(email, "bob@example.com")
        XCTAssertEqual(password, "secret123")
    }

    func testHappyPathPassesJWTToMint() async {
        let session = SupabaseSession(accessToken: "the-jwt", refreshToken: "r", userEmail: "a@b.com")
        await fakeAuth.setStubbedSignIn(.success(session))

        coord.presentSignIn()
        guard let authWin = capturedAuthWindow else { return XCTFail("No auth window") }
        authWin.emailField?.stringValue = "a@b.com"
        authWin.passwordField?.stringValue = "pass"
        authWin.handleSubmit()

        try? await Task.sleep(nanoseconds: 200_000_000)

        let jwt = await fakeAuth.lastMintJWT
        XCTAssertEqual(jwt, "the-jwt")
    }

    func testHappyPathSetsDeviceNameAndPlatform() async {
        coord.deviceName = { "my-mac.local" }
        coord.osPlatform = { "darwin" }

        coord.presentSignIn()
        guard let authWin = capturedAuthWindow else { return XCTFail("No auth window") }
        authWin.emailField?.stringValue = "a@b.com"
        authWin.passwordField?.stringValue = "pass"
        authWin.handleSubmit()

        try? await Task.sleep(nanoseconds: 200_000_000)

        let deviceName = await fakeAuth.lastMintDeviceName
        let platform = await fakeAuth.lastMintOSPlatform
        XCTAssertEqual(deviceName, "my-mac.local")
        XCTAssertEqual(platform, "darwin")
    }

    // MARK: - Step 1 failure (Supabase)

    func testInvalidCredentialsShowsInlineError() async {
        await fakeAuth.setStubbedSignIn(.failure(.invalidCredentials))

        coord.presentSignIn()
        guard let authWin = capturedAuthWindow else { return XCTFail("No auth window") }
        authWin.emailField?.stringValue = "a@b.com"
        authWin.passwordField?.stringValue = "wrong"
        authWin.handleSubmit()

        try? await Task.sleep(nanoseconds: 200_000_000)

        XCTAssertTrue(authSucceededCalls.isEmpty, "onAuthSucceeded must not fire")
        XCTAssertEqual(authWin.errorLabel?.stringValue, "Invalid email or password.")
        XCTAssertEqual(authWin.errorLabel?.isHidden, false)
    }

    func testEmailNotConfirmedShowsInlineError() async {
        await fakeAuth.setStubbedSignIn(.failure(.emailNotConfirmed))

        coord.presentSignIn()
        guard let authWin = capturedAuthWindow else { return XCTFail("No auth window") }
        authWin.emailField?.stringValue = "a@b.com"
        authWin.passwordField?.stringValue = "pass"
        authWin.handleSubmit()

        try? await Task.sleep(nanoseconds: 200_000_000)

        XCTAssertTrue(authSucceededCalls.isEmpty)
        XCTAssertTrue(authWin.errorLabel?.stringValue.contains("confirm your email") == true)
    }

    func testRateLimitedShowsInlineError() async {
        await fakeAuth.setStubbedSignIn(.failure(.rateLimited))

        coord.presentSignIn()
        guard let authWin = capturedAuthWindow else { return XCTFail("No auth window") }
        authWin.emailField?.stringValue = "a@b.com"
        authWin.passwordField?.stringValue = "pass"
        authWin.handleSubmit()

        try? await Task.sleep(nanoseconds: 200_000_000)

        XCTAssertTrue(authSucceededCalls.isEmpty)
        XCTAssertTrue(authWin.errorLabel?.stringValue.contains("Too many attempts") == true)
    }

    func testNetworkErrorShowsInlineError() async {
        await fakeAuth.setStubbedSignIn(.failure(.networkError(URLError(.notConnectedToInternet))))

        coord.presentSignIn()
        guard let authWin = capturedAuthWindow else { return XCTFail("No auth window") }
        authWin.emailField?.stringValue = "a@b.com"
        authWin.passwordField?.stringValue = "pass"
        authWin.handleSubmit()

        try? await Task.sleep(nanoseconds: 200_000_000)

        XCTAssertTrue(authSucceededCalls.isEmpty)
        XCTAssertTrue(authWin.errorLabel?.stringValue.contains("Couldn't reach Taproot") == true)
    }

    // MARK: - Step 2 failure (mint)

    func testNoWorkspaceShowsInlineError() async {
        await fakeAuth.setStubbedMint(.failure(.noWorkspace))

        coord.presentSignIn()
        guard let authWin = capturedAuthWindow else { return XCTFail("No auth window") }
        authWin.emailField?.stringValue = "a@b.com"
        authWin.passwordField?.stringValue = "pass"
        authWin.handleSubmit()

        try? await Task.sleep(nanoseconds: 200_000_000)

        XCTAssertTrue(authSucceededCalls.isEmpty)
        XCTAssertTrue(authWin.errorLabel?.stringValue.contains("Finish setup at taproothq.com") == true)
    }

    func testMintServerErrorShowsInlineError() async {
        await fakeAuth.setStubbedMint(.failure(.server(status: 500, message: nil)))

        coord.presentSignIn()
        guard let authWin = capturedAuthWindow else { return XCTFail("No auth window") }
        authWin.emailField?.stringValue = "a@b.com"
        authWin.passwordField?.stringValue = "pass"
        authWin.handleSubmit()

        try? await Task.sleep(nanoseconds: 200_000_000)

        XCTAssertTrue(authSucceededCalls.isEmpty)
        XCTAssertTrue(authWin.errorLabel?.stringValue.contains("500") == true)
    }

    // MARK: - Cancel

    func testCancelCallsOnCancel() {
        coord.presentSignIn()
        capturedAuthWindow?.handleCancel()

        XCTAssertEqual(cancelCount, 1)
        XCTAssertTrue(authSucceededCalls.isEmpty)
    }

    // MARK: - isAuthWindowOpen

    func testIsAuthWindowOpenFalseBeforePresentSignIn() {
        XCTAssertFalse(coord.isAuthWindowOpen)
    }

    func testIsAuthWindowOpenTrueAfterPresentSignIn() {
        coord.presentSignIn()
        // showWindow(nil) makes the window visible in NSApp context
        XCTAssertTrue(coord.isAuthWindowOpen)
    }

    func testIsAuthWindowOpenFalseAfterCancel() {
        coord.presentSignIn()
        capturedAuthWindow?.handleCancel()
        XCTAssertFalse(coord.isAuthWindowOpen)
    }

    // MARK: - Sign-up link

    func testSignUpLinkCallsOpenSignUpURL() {
        var signUpFired = false
        coord.openSignUpURL = { signUpFired = true }

        coord.presentSignIn()
        guard let authWin = capturedAuthWindow else { return XCTFail("No auth window") }

        // Find and click the sign-up button in the view hierarchy.
        if let button = findButton(in: authWin.window?.contentView, title: "Don't have an account? Create one in your browser →") {
            button.performClick(nil)
        } else {
            XCTFail("Sign-up button not found in view hierarchy")
        }

        XCTAssertTrue(signUpFired, "Clicking sign-up link must trigger openSignUpURL")
    }

    // MARK: - Step counts

    func testHappyPathCallsBothServiceSteps() async {
        coord.presentSignIn()
        guard let authWin = capturedAuthWindow else { return XCTFail("No auth window") }
        authWin.emailField?.stringValue = "a@b.com"
        authWin.passwordField?.stringValue = "pass"
        authWin.handleSubmit()

        try? await Task.sleep(nanoseconds: 200_000_000)

        let signInCount = await fakeAuth.signInCallCount
        let mintCount = await fakeAuth.mintCallCount
        XCTAssertEqual(signInCount, 1)
        XCTAssertEqual(mintCount, 1)
    }

    func testStep1FailureDoesNotCallMint() async {
        await fakeAuth.setStubbedSignIn(.failure(.invalidCredentials))

        coord.presentSignIn()
        guard let authWin = capturedAuthWindow else { return XCTFail("No auth window") }
        authWin.emailField?.stringValue = "a@b.com"
        authWin.passwordField?.stringValue = "wrong"
        authWin.handleSubmit()

        try? await Task.sleep(nanoseconds: 200_000_000)

        let mintCount = await fakeAuth.mintCallCount
        XCTAssertEqual(mintCount, 0, "Mint must not be called when step 1 fails")
    }

    // MARK: - Helpers

    private func findButton(in view: NSView?, title: String) -> NSButton? {
        guard let view else { return nil }
        if let button = view as? NSButton, button.title == title { return button }
        for sub in view.subviews {
            if let found = findButton(in: sub, title: title) { return found }
        }
        return nil
    }
}
