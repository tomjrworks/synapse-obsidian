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

    // MARK: - deep-link URL construction (T11.4 / 0.1.4)

    func test_buildOpenURL_nilPath_returnsBareScheme() {
        XCTAssertEqual(
            ObsidianAppDetector.buildOpenURL(at: nil)?.absoluteString,
            "obsidian://"
        )
    }

    func test_buildOpenURL_plainPath_buildsOpenQuery() {
        let url = URL(fileURLWithPath: "/Users/me/MyVault")
        let result = ObsidianAppDetector.buildOpenURL(at: url)
        XCTAssertEqual(
            result?.absoluteString,
            "obsidian://open?path=/Users/me/MyVault"
        )
    }

    func test_buildOpenURL_pathWithSpaces_percentEncodesSpaces() {
        let url = URL(fileURLWithPath: "/Users/me/My Vault/notes")
        let result = ObsidianAppDetector.buildOpenURL(at: url)
        let absolute = result?.absoluteString ?? ""
        XCTAssertTrue(
            absolute.contains("My%20Vault"),
            "expected percent-encoded space, got: \(absolute)"
        )
        // Round-trip: parsing the URL back should give us the original path.
        let parsed = URLComponents(string: absolute)
        let pathItem = parsed?.queryItems?.first(where: { $0.name == "path" })
        XCTAssertEqual(pathItem?.value, "/Users/me/My Vault/notes")
    }

    func test_buildOpenURL_pathWithAmpersand_isQuerySafe() {
        let url = URL(fileURLWithPath: "/Users/me/notes & ideas")
        let result = ObsidianAppDetector.buildOpenURL(at: url)
        let absolute = result?.absoluteString ?? ""
        // `&` must be encoded so Obsidian doesn't see it as a query-arg
        // separator and lose the rest of the path.
        XCTAssertFalse(
            absolute.contains("notes & ideas"),
            "raw `&` would split the query; expected encoded form"
        )
        let parsed = URLComponents(string: absolute)
        let pathItem = parsed?.queryItems?.first(where: { $0.name == "path" })
        XCTAssertEqual(pathItem?.value, "/Users/me/notes & ideas")
        XCTAssertEqual(parsed?.queryItems?.count, 1)
    }

    func test_buildOpenURL_pathWithUnicode_roundTrips() {
        let url = URL(fileURLWithPath: "/Users/me/café/garden")
        let result = ObsidianAppDetector.buildOpenURL(at: url)
        let parsed = URLComponents(string: result?.absoluteString ?? "")
        let pathItem = parsed?.queryItems?.first(where: { $0.name == "path" })
        XCTAssertEqual(pathItem?.value, "/Users/me/café/garden")
    }
}
