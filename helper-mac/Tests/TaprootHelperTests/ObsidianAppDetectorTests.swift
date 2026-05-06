import XCTest
@testable import TaprootHelper

final class ObsidianAppDetectorTests: XCTestCase {
    func test_isInstalled_true_whenLookupReturnsURL() {
        let dummy = URL(fileURLWithPath: "/Applications/Obsidian.app")
        XCTAssertTrue(ObsidianAppDetector.isInstalled(lookup: { _ in dummy }))
    }

    func test_isInstalled_false_whenLookupReturnsNil() {
        XCTAssertFalse(ObsidianAppDetector.isInstalled(lookup: { _ in nil }))
    }

    func test_openObsidian_callsOpenerWithSchemeURL() {
        var captured: URL?
        ObsidianAppDetector.openObsidian(opener: { captured = $0 })
        XCTAssertEqual(captured?.absoluteString, "obsidian://")
    }
}
