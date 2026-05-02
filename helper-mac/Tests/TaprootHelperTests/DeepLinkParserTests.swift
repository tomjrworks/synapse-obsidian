import XCTest
@testable import TaprootHelper

// 64-char lowercase hex matches the server's `randomBytes(32).toString("hex")`
// auth-code format (B1 code-exchange flow). The bearer never appears in
// the deep-link URL anymore — exchange-only.
private let kValidCode = String(repeating: "ab12cd34", count: 8)
private let kCodeAllZeros = String(repeating: "0", count: 64)

final class DeepLinkParserTests: XCTestCase {
    func testValidAuthURL() throws {
        let id = UUID()
        let url = URL(string: "taproot://auth?code=\(kValidCode)&workspace=\(id.uuidString)")!
        let link = try DeepLinkParser.parseAuth(url)
        XCTAssertEqual(link.code, kValidCode)
        XCTAssertEqual(link.workspaceID, id)
    }

    func testHostIsCaseInsensitive() throws {
        // Per RFC 3986, hosts are case-insensitive. URL preserves the original
        // casing in `.host`, so the parser must lowercase before comparing.
        let id = UUID()
        let url = URL(string: "taproot://AUTH?code=\(kCodeAllZeros)&workspace=\(id.uuidString)")!
        let link = try DeepLinkParser.parseAuth(url)
        XCTAssertEqual(link.code, kCodeAllZeros)
        XCTAssertEqual(link.workspaceID, id)
    }

    func testWrongScheme() {
        let url = URL(string: "https://auth?code=\(kValidCode)&workspace=\(UUID().uuidString)")!
        XCTAssertThrowsError(try DeepLinkParser.parseAuth(url)) { err in
            XCTAssertEqual(err as? DeepLinkParseError, .wrongScheme)
        }
    }

    func testWrongHost() {
        let url = URL(string: "taproot://other?code=\(kValidCode)&workspace=\(UUID().uuidString)")!
        XCTAssertThrowsError(try DeepLinkParser.parseAuth(url)) { err in
            XCTAssertEqual(err as? DeepLinkParseError, .wrongHost)
        }
    }

    func testMissingCode() {
        let url = URL(string: "taproot://auth?workspace=\(UUID().uuidString)")!
        XCTAssertThrowsError(try DeepLinkParser.parseAuth(url)) { err in
            XCTAssertEqual(err as? DeepLinkParseError, .missingCode)
        }
    }

    func testEmptyCode() {
        let url = URL(string: "taproot://auth?code=&workspace=\(UUID().uuidString)")!
        XCTAssertThrowsError(try DeepLinkParser.parseAuth(url)) { err in
            XCTAssertEqual(err as? DeepLinkParseError, .missingCode)
        }
    }

    func testCodeTooShort() {
        // Only 64-char hex is accepted — anything shorter is rejected even
        // if every character is in the hex charset.
        let shortCode = String(repeating: "a", count: 32)
        let url = URL(string: "taproot://auth?code=\(shortCode)&workspace=\(UUID().uuidString)")!
        XCTAssertThrowsError(try DeepLinkParser.parseAuth(url)) { err in
            XCTAssertEqual(err as? DeepLinkParseError, .invalidCode)
        }
    }

    func testCodeTooLong() {
        let longCode = String(repeating: "a", count: 65)
        let url = URL(string: "taproot://auth?code=\(longCode)&workspace=\(UUID().uuidString)")!
        XCTAssertThrowsError(try DeepLinkParser.parseAuth(url)) { err in
            XCTAssertEqual(err as? DeepLinkParseError, .invalidCode)
        }
    }

    func testCodeUppercaseRejected() {
        // Server emits lowercase hex; uppercase shouldn't pass the strict charset
        // check (avoids ambiguity with case-folded comparisons later).
        let upperCode = String(repeating: "AB", count: 32)
        let url = URL(string: "taproot://auth?code=\(upperCode)&workspace=\(UUID().uuidString)")!
        XCTAssertThrowsError(try DeepLinkParser.parseAuth(url)) { err in
            XCTAssertEqual(err as? DeepLinkParseError, .invalidCode)
        }
    }

    func testCodeInvalidCharset() {
        // `g` is outside the [0-9a-f] charset.
        let badCode = String(repeating: "g", count: 64)
        let url = URL(string: "taproot://auth?code=\(badCode)&workspace=\(UUID().uuidString)")!
        XCTAssertThrowsError(try DeepLinkParser.parseAuth(url)) { err in
            XCTAssertEqual(err as? DeepLinkParseError, .invalidCode)
        }
    }

    func testMissingWorkspace() {
        let url = URL(string: "taproot://auth?code=\(kValidCode)")!
        XCTAssertThrowsError(try DeepLinkParser.parseAuth(url)) { err in
            XCTAssertEqual(err as? DeepLinkParseError, .missingWorkspace)
        }
    }

    func testInvalidWorkspaceUUID() {
        let url = URL(string: "taproot://auth?code=\(kValidCode)&workspace=not-a-uuid")!
        XCTAssertThrowsError(try DeepLinkParser.parseAuth(url)) { err in
            XCTAssertEqual(err as? DeepLinkParseError, .invalidWorkspaceUUID)
        }
    }

    func testBearerParamRejected() {
        // B1 regression guard: the old `?bearer=…` shape MUST fail to parse so
        // a stale browser-history link can never reach the helper as an
        // auth payload.
        let bearer = String(repeating: "a", count: 64)
        let url = URL(string: "taproot://auth?bearer=\(bearer)&workspace=\(UUID().uuidString)")!
        XCTAssertThrowsError(try DeepLinkParser.parseAuth(url)) { err in
            XCTAssertEqual(err as? DeepLinkParseError, .missingCode)
        }
    }
}
