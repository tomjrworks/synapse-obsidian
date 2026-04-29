import XCTest
@testable import TaprootHelper

final class BaseURLResolverTests: XCTestCase {
    func testEnvOverrideWinsOverPlist() {
        let url = BaseURLResolver.resolve(
            env: ["TAPROOT_BASE_URL": "https://from-env.example.com"],
            bundleLookup: { key in
                key == "TaprootBaseURL" ? "https://from-plist.example.com" : nil
            }
        )
        XCTAssertEqual(url.absoluteString, "https://from-env.example.com")
    }

    func testFallsBackToPlistWhenEnvAbsent() {
        let url = BaseURLResolver.resolve(
            env: [:],
            bundleLookup: { key in
                key == "TaprootBaseURL" ? "https://from-plist.example.com" : nil
            }
        )
        XCTAssertEqual(url.absoluteString, "https://from-plist.example.com")
    }

    func testFallsBackToDefaultWhenNeitherSet() {
        let url = BaseURLResolver.resolve(
            env: [:],
            bundleLookup: { _ in nil }
        )
        XCTAssertEqual(url, BaseURLResolver.defaultURL)
    }

    /// Bad scheme in env must fall through to plist (not be silently accepted).
    /// Locks the §3.2 invariant: a malformed override never breaks runtime —
    /// it just gets ignored in favor of the next layer.
    func testRejectsBadSchemeAndFallsThrough() {
        let url = BaseURLResolver.resolve(
            env: ["TAPROOT_BASE_URL": "ftp://bad-scheme.example.com"],
            bundleLookup: { key in
                key == "TaprootBaseURL" ? "https://valid.example.com" : nil
            }
        )
        XCTAssertEqual(url.absoluteString, "https://valid.example.com")
    }
}
