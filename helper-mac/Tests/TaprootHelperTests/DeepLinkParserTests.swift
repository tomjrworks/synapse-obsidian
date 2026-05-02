import XCTest
@testable import TaprootHelper

// 64-char bearer that satisfies the 32-256 range + [A-Za-z0-9_-] charset.
private let kValidBearer = String(repeating: "a1b2c3d4", count: 8)
// 32-char variants for tests that check exact bearer values.
private let kBearerABC = "abc" + String(repeating: "0", count: 29)
private let kBearerABC123 = "abc123" + String(repeating: "0", count: 26)

final class DeepLinkParserTests: XCTestCase {
    func testValidAuthURL() throws {
        let id = UUID()
        let url = URL(string: "taproot://auth?bearer=\(kBearerABC123)&workspace=\(id.uuidString)")!
        let link = try DeepLinkParser.parseAuth(url)
        XCTAssertEqual(link.bearer, kBearerABC123)
        XCTAssertEqual(link.workspaceID, id)
    }

    func testHostIsCaseInsensitive() throws {
        // Per RFC 3986, hosts are case-insensitive. URL preserves the original
        // casing in `.host`, so the parser must lowercase before comparing.
        let id = UUID()
        let url = URL(string: "taproot://AUTH?bearer=\(kBearerABC)&workspace=\(id.uuidString)")!
        let link = try DeepLinkParser.parseAuth(url)
        XCTAssertEqual(link.bearer, kBearerABC)
        XCTAssertEqual(link.workspaceID, id)
    }

    func testValidAuthURLWithLongBearer() throws {
        // 64-char hex bearer matches the real `oauth_tokens` shape.
        let id = UUID()
        let url = URL(string: "taproot://auth?bearer=\(kValidBearer)&workspace=\(id.uuidString)")!
        let link = try DeepLinkParser.parseAuth(url)
        XCTAssertEqual(link.bearer, kValidBearer)
        XCTAssertEqual(link.workspaceID, id)
    }

    func testWrongScheme() {
        let url = URL(string: "https://auth?bearer=\(kValidBearer)&workspace=\(UUID().uuidString)")!
        XCTAssertThrowsError(try DeepLinkParser.parseAuth(url)) { err in
            XCTAssertEqual(err as? DeepLinkParseError, .wrongScheme)
        }
    }

    func testWrongHost() {
        let url = URL(string: "taproot://other?bearer=\(kValidBearer)&workspace=\(UUID().uuidString)")!
        XCTAssertThrowsError(try DeepLinkParser.parseAuth(url)) { err in
            XCTAssertEqual(err as? DeepLinkParseError, .wrongHost)
        }
    }

    func testMissingBearer() {
        let url = URL(string: "taproot://auth?workspace=\(UUID().uuidString)")!
        XCTAssertThrowsError(try DeepLinkParser.parseAuth(url)) { err in
            XCTAssertEqual(err as? DeepLinkParseError, .missingBearer)
        }
    }

    func testEmptyBearer() {
        let url = URL(string: "taproot://auth?bearer=&workspace=\(UUID().uuidString)")!
        XCTAssertThrowsError(try DeepLinkParser.parseAuth(url)) { err in
            XCTAssertEqual(err as? DeepLinkParseError, .missingBearer)
        }
    }

    func testBearerTooShort() {
        // Bearers shorter than 32 chars are rejected (truncated-token hardening).
        let url = URL(string: "taproot://auth?bearer=short&workspace=\(UUID().uuidString)")!
        XCTAssertThrowsError(try DeepLinkParser.parseAuth(url)) { err in
            XCTAssertEqual(err as? DeepLinkParseError, .invalidBearer)
        }
    }

    func testBearerTooLong() {
        let longBearer = String(repeating: "a", count: 257)
        let url = URL(string: "taproot://auth?bearer=\(longBearer)&workspace=\(UUID().uuidString)")!
        XCTAssertThrowsError(try DeepLinkParser.parseAuth(url)) { err in
            XCTAssertEqual(err as? DeepLinkParseError, .invalidBearer)
        }
    }

    func testBearerInvalidCharset() {
        // Spaces and special chars outside [A-Za-z0-9_-] are rejected.
        let badBearer = String(repeating: "a", count: 30) + "!!"
        let url = URL(string: "taproot://auth?bearer=\(badBearer)&workspace=\(UUID().uuidString)")!
        XCTAssertThrowsError(try DeepLinkParser.parseAuth(url)) { err in
            XCTAssertEqual(err as? DeepLinkParseError, .invalidBearer)
        }
    }

    func testMissingWorkspace() {
        let url = URL(string: "taproot://auth?bearer=\(kValidBearer)")!
        XCTAssertThrowsError(try DeepLinkParser.parseAuth(url)) { err in
            XCTAssertEqual(err as? DeepLinkParseError, .missingWorkspace)
        }
    }

    func testInvalidWorkspaceUUID() {
        let url = URL(string: "taproot://auth?bearer=\(kValidBearer)&workspace=not-a-uuid")!
        XCTAssertThrowsError(try DeepLinkParser.parseAuth(url)) { err in
            XCTAssertEqual(err as? DeepLinkParseError, .invalidWorkspaceUUID)
        }
    }
}
