import XCTest

/// M15 — guards against a malformed `SUPublicEDKey` shipping in `Info.plist`.
/// Sparkle's signature verifier expects exactly 32 bytes of base64-decoded
/// Ed25519 public key; a placeholder, garbled paste, or truncated key would
/// silently break update verification at runtime.
///
/// The plist is linker-injected via `-sectcreate __TEXT __info_plist` in
/// `Package.swift`, which lands it on the executable binary's `__TEXT,__info_plist`
/// section — not on the xctest test bundle's `Bundle.main`. So we read the
/// source file directly via `#filePath` traversal and parse with
/// `PropertyListSerialization`. Validates the source-of-truth.
final class InfoPlistTests: XCTestCase {
    func testSUPublicEDKeyIsValid32ByteBase64() throws {
        let testFile = URL(fileURLWithPath: #filePath)
        let infoPlistURL = testFile
            .deletingLastPathComponent() // TaprootHelperTests/
            .deletingLastPathComponent() // Tests/
            .deletingLastPathComponent() // helper-mac/
            .appendingPathComponent("Sources/TaprootHelper/Info.plist")
        let data = try Data(contentsOf: infoPlistURL)
        let plist = try PropertyListSerialization.propertyList(from: data, format: nil)
        let dict = try XCTUnwrap(plist as? [String: Any])
        let key = try XCTUnwrap(dict["SUPublicEDKey"] as? String,
                                "SUPublicEDKey missing or not a string")
        XCTAssertNotEqual(key, "PLACEHOLDER_REPLACED_IN_COMMIT_7",
                          "SUPublicEDKey placeholder still present — paste real key")
        let decoded = try XCTUnwrap(Data(base64Encoded: key),
                                    "SUPublicEDKey is not valid base64")
        XCTAssertEqual(decoded.count, 32,
                       "SUPublicEDKey must decode to 32 bytes (Ed25519); got \(decoded.count)")
    }

    /// S29 — guards the sandbox entitlements file. Missing keys or a typo
    /// in the keychain-access-group would break the helper at runtime once
    /// the sandbox is applied.
    func testSandboxEntitlementsAreWellFormed() throws {
        let testFile = URL(fileURLWithPath: #filePath)
        let entitlementsURL = testFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/TaprootHelper/TaprootHelper.entitlements")
        let data = try Data(contentsOf: entitlementsURL)
        let plist = try PropertyListSerialization.propertyList(from: data, format: nil)
        let dict = try XCTUnwrap(plist as? [String: Any])

        XCTAssertEqual(dict["com.apple.security.app-sandbox"] as? Bool, true,
                       "app-sandbox must be true")
        XCTAssertEqual(dict["com.apple.security.network.client"] as? Bool, true,
                       "network.client required for connect.taproothq.com")
        XCTAssertEqual(dict["com.apple.security.files.user-selected.read-write"] as? Bool, true,
                       "user-selected.read-write required for the vault folder picker")
        XCTAssertEqual(dict["com.apple.security.files.bookmarks.app-scope"] as? Bool, true,
                       "app-scope bookmarks required to remember the vault folder across launches")

        let groups = try XCTUnwrap(dict["keychain-access-groups"] as? [String])
        XCTAssertEqual(groups, ["5ALAY5V34U.com.taproot.helper"],
                       "Team-prefixed keychain access group must match Tom's signing identity")
    }
}
