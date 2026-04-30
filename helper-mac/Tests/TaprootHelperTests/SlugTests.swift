import XCTest
@testable import TaprootHelper

final class SlugTests: XCTestCase {
    func testSlugFromSimpleASCII() {
        XCTAssertEqual(Slug.from("Toms Garden"), "toms-garden")
    }

    func testSlugFromMixedCase() {
        XCTAssertEqual(Slug.from("Tom's Vault"), "tom-s-vault")
    }

    func testSlugFromPunctuation() {
        XCTAssertEqual(Slug.from("Hello, World!"), "hello-world")
    }

    func testSlugFromLeadingTrailingWhitespace() {
        XCTAssertEqual(Slug.from("  spaces  "), "spaces")
    }

    func testSlugFromMultipleSpaces() {
        XCTAssertEqual(Slug.from("a   b"), "a-b")
    }

    func testSlugFromUnicodeStripped() {
        // Stage 1 simplification: non-ASCII characters are stripped silently.
        XCTAssertEqual(Slug.from("café 日本"), "caf")
    }

    func testSlugFromEmptyAfterSanitization() {
        XCTAssertNil(Slug.from("!!!"))
    }

    func testSlugFromEmptyInput() {
        XCTAssertNil(Slug.from(""))
    }

    func testSlugFromAllWhitespace() {
        XCTAssertNil(Slug.from("   "))
    }
}
