import XCTest
@testable import TaprootHelper

final class DeepLinkParserTests: XCTestCase {
    func testValidAuthURL() throws {
        let id = UUID()
        let url = URL(string: "taproot://auth?bearer=abc123&workspace=\(id.uuidString)")!
        let link = try DeepLinkParser.parseAuth(url)
        XCTAssertEqual(link.bearer, "abc123")
        XCTAssertEqual(link.workspaceID, id)
    }

    func testHostIsCaseInsensitive() throws {
        // Per RFC 3986, hosts are case-insensitive. URL preserves the original
        // casing in `.host`, so the parser must lowercase before comparing.
        let id = UUID()
        let url = URL(string: "taproot://AUTH?bearer=abc&workspace=\(id.uuidString)")!
        let link = try DeepLinkParser.parseAuth(url)
        XCTAssertEqual(link.bearer, "abc")
        XCTAssertEqual(link.workspaceID, id)
    }

    func testValidAuthURLWithLongBearer() throws {
        // 64-char hex bearer matches the real `oauth_tokens` shape.
        let id = UUID()
        let bearer = String(repeating: "a1b2c3d4", count: 8)
        let url = URL(string: "taproot://auth?bearer=\(bearer)&workspace=\(id.uuidString)")!
        let link = try DeepLinkParser.parseAuth(url)
        XCTAssertEqual(link.bearer, bearer)
        XCTAssertEqual(link.workspaceID, id)
    }

    func testWrongScheme() {
        let url = URL(string: "https://auth?bearer=abc&workspace=\(UUID().uuidString)")!
        XCTAssertThrowsError(try DeepLinkParser.parseAuth(url)) { err in
            XCTAssertEqual(err as? DeepLinkParseError, .wrongScheme)
        }
    }

    func testWrongHost() {
        let url = URL(string: "taproot://other?bearer=abc&workspace=\(UUID().uuidString)")!
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

    func testMissingWorkspace() {
        let url = URL(string: "taproot://auth?bearer=abc")!
        XCTAssertThrowsError(try DeepLinkParser.parseAuth(url)) { err in
            XCTAssertEqual(err as? DeepLinkParseError, .missingWorkspace)
        }
    }

    func testInvalidWorkspaceUUID() {
        let url = URL(string: "taproot://auth?bearer=abc&workspace=not-a-uuid")!
        XCTAssertThrowsError(try DeepLinkParser.parseAuth(url)) { err in
            XCTAssertEqual(err as? DeepLinkParseError, .invalidWorkspaceUUID)
        }
    }
}
