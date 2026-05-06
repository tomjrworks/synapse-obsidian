import XCTest
import AppKit
@testable import TaprootHelper

@MainActor
final class AuthWindowControllerTests: XCTestCase {
    private var submitCalls: [(String, String)] = []
    private var cancelCount = 0
    private var signUpCount = 0
    private var ctrl: AuthWindowController!

    override func setUpWithError() throws {
        _ = NSApplication.shared
        submitCalls = []
        cancelCount = 0
        signUpCount = 0
        ctrl = AuthWindowController(
            onSubmit: { [weak self] email, password in
                self?.submitCalls.append((email, password))
            },
            onCancel: { [weak self] in
                self?.cancelCount += 1
            },
            onSignUpRequested: { [weak self] in
                self?.signUpCount += 1
            }
        )
    }

    override func tearDownWithError() throws {
        ctrl.window?.close()
        ctrl = nil
    }

    // MARK: - Submit

    func testSubmitWithBothFieldsCallsOnSubmit() {
        ctrl.emailField?.stringValue = "alice@example.com"
        ctrl.passwordField?.stringValue = "hunter2"

        ctrl.handleSubmit()

        XCTAssertEqual(submitCalls.count, 1)
        XCTAssertEqual(submitCalls.first?.0, "alice@example.com")
        XCTAssertEqual(submitCalls.first?.1, "hunter2")
    }

    func testSubmitWithEmptyEmailShowsInlineError() {
        ctrl.emailField?.stringValue = ""
        ctrl.passwordField?.stringValue = "hunter2"

        ctrl.handleSubmit()

        XCTAssertTrue(submitCalls.isEmpty, "onSubmit must not fire when email is empty")
        XCTAssertEqual(ctrl.errorLabel?.isHidden, false)
        XCTAssertEqual(ctrl.errorLabel?.stringValue, "Enter your email.")
    }

    func testSubmitWithEmptyPasswordShowsInlineError() {
        ctrl.emailField?.stringValue = "alice@example.com"
        ctrl.passwordField?.stringValue = ""

        ctrl.handleSubmit()

        XCTAssertTrue(submitCalls.isEmpty, "onSubmit must not fire when password is empty")
        XCTAssertEqual(ctrl.errorLabel?.isHidden, false)
        XCTAssertEqual(ctrl.errorLabel?.stringValue, "Enter your password.")
    }

    func testSubmitSetsLoadingStateBeforeCallingOnSubmit() {
        var capturedButtonState: Bool?
        ctrl = AuthWindowController(
            onSubmit: { [weak self] _, _ in
                capturedButtonState = self?.ctrl.submitButton?.isEnabled
            },
            onCancel: { },
            onSignUpRequested: { }
        )
        ctrl.emailField?.stringValue = "a@b.com"
        ctrl.passwordField?.stringValue = "pass"

        ctrl.handleSubmit()

        XCTAssertEqual(capturedButtonState, false, "Submit button must be disabled while loading")
    }

    // MARK: - Inline error display

    func testShowInlineErrorSetsLabelAndReenablesForm() {
        // First call handleSubmit to put form into loading state.
        ctrl.emailField?.stringValue = "a@b.com"
        ctrl.passwordField?.stringValue = "pass"
        ctrl.handleSubmit()

        ctrl.showInlineError("Invalid email or password.")

        XCTAssertEqual(ctrl.errorLabel?.stringValue, "Invalid email or password.")
        XCTAssertEqual(ctrl.errorLabel?.isHidden, false)
        XCTAssertEqual(ctrl.submitButton?.isEnabled, true, "Submit button re-enabled after error")
        XCTAssertEqual(ctrl.emailField?.isEnabled, true, "Email field re-enabled after error")
        XCTAssertEqual(ctrl.passwordField?.isEnabled, true, "Password field re-enabled after error")
    }

    // MARK: - Cancel

    func testHandleCancelCallsOnCancel() {
        ctrl.handleCancel()

        XCTAssertEqual(cancelCount, 1)
    }

    func testHandleCancelDoesNotCallOnSubmit() {
        ctrl.handleCancel()

        XCTAssertTrue(submitCalls.isEmpty)
    }

    // MARK: - Red-X close (windowWillClose without didFinish)

    func testRedXCloseCallsOnCancelOnce() {
        // Simulate the user clicking the red-X close button without going through
        // handleCancel or handleSubmit — `didFinish` stays false, so
        // windowWillClose must fire onCancel.
        ctrl.showWindow(nil)
        ctrl.window?.close()

        XCTAssertEqual(cancelCount, 1)
    }

    func testHandleCancelThenWindowCloseDoesNotDoubleFire() {
        ctrl.handleCancel()
        // Window is already closed by handleCancel; windowWillClose fires again
        // but `didFinish = true` means onCancel must NOT be called a second time.
        ctrl.window?.close()

        XCTAssertEqual(cancelCount, 1, "onCancel must fire exactly once")
    }

    // MARK: - Sign-up link

    func testSignUpLinkCallsOnSignUpRequested() {
        // Access the sign-up button via the window's content view to simulate a click.
        // Since the button calls handleSubmit logic through @objc selector, we directly
        // call the action by inspecting the controller — use the public surface only.
        // The sign-up closure fires when the window closes + onSignUpRequested is called.
        // We test this via a custom ctrl that records the signUp call.
        var fired = false
        let ctrl2 = AuthWindowController(
            onSubmit: { _, _ in },
            onCancel: { },
            onSignUpRequested: { fired = true }
        )
        ctrl2.showWindow(nil)
        // Find the sign-up button in the view hierarchy and simulate a click.
        if let button = findButton(in: ctrl2.window?.contentView, title: "Don't have an account? Create one in your browser →") {
            button.performClick(nil)
        }
        XCTAssertTrue(fired, "Clicking sign-up link must call onSignUpRequested")
        ctrl2.window?.close()
    }

    // MARK: - Window appearance

    func testWindowHasCorrectTitle() {
        XCTAssertEqual(ctrl.window?.title, "Sign in to Taproot")
    }

    func testErrorLabelInitiallyHidden() {
        XCTAssertEqual(ctrl.errorLabel?.isHidden, true)
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
