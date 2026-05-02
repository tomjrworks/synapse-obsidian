import XCTest
import CryptoKit
@testable import TaprootHelper

final class PKCEStoreTests: XCTestCase {
    func testBeginSigninReturnsBase64URLChallengeAndS256() {
        let store = PKCEStore()
        let (challenge, method) = store.beginSignin()
        XCTAssertEqual(method, "S256")
        // SHA-256 → 32 bytes → 43-char base64url (no padding).
        XCTAssertEqual(challenge.count, 43)
        // Charset must be base64url alphabet only.
        let base64URLCharset = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        for scalar in challenge.unicodeScalars {
            XCTAssertTrue(base64URLCharset.contains(scalar), "Unexpected char in challenge: \(scalar)")
        }
    }

    func testBeginThenConsumeRoundTrip() {
        let store = PKCEStore()
        let (challenge, _) = store.beginSignin()
        guard let verifier = store.consumeVerifier() else {
            return XCTFail("verifier should be non-nil after beginSignin")
        }
        // Verifier must be 43-128 chars from the base64url alphabet.
        XCTAssertGreaterThanOrEqual(verifier.count, 43)
        XCTAssertLessThanOrEqual(verifier.count, 128)
        // SHA-256(verifier) base64url-encoded must equal the challenge.
        let derived = Data(SHA256.hash(data: Data(verifier.utf8)))
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        XCTAssertEqual(derived, challenge)
    }

    func testConsumeIsOneShot() {
        let store = PKCEStore()
        store.beginSignin()
        XCTAssertNotNil(store.consumeVerifier())
        XCTAssertNil(store.consumeVerifier(), "second consume must return nil")
    }

    func testConsumeWithoutBeginReturnsNil() {
        let store = PKCEStore()
        XCTAssertNil(store.consumeVerifier())
    }

    func testMostRecentWinsOnRepeatedBegin() {
        // Single in-flight signin attempt — second beginSignin replaces the
        // first verifier. The challenge from the first call is no longer
        // exchangeable.
        let store = PKCEStore()
        let (challenge1, _) = store.beginSignin()
        let (challenge2, _) = store.beginSignin()
        XCTAssertNotEqual(challenge1, challenge2, "second begin must rotate the verifier")
        guard let verifier2 = store.consumeVerifier() else {
            return XCTFail("verifier should be present after second begin")
        }
        let derived = Data(SHA256.hash(data: Data(verifier2.utf8)))
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        XCTAssertEqual(derived, challenge2, "consumed verifier must match the most-recent challenge")
    }

    func testConcurrentAccessIsSafe() {
        // Sanity check: hammer beginSignin/consumeVerifier from multiple
        // queues. The internal serial DispatchQueue should keep state
        // consistent (no crash, no data race).
        let store = PKCEStore()
        let group = DispatchGroup()
        let q = DispatchQueue.global(qos: .userInitiated)
        for _ in 0..<200 {
            group.enter()
            q.async {
                store.beginSignin()
                _ = store.consumeVerifier()
                group.leave()
            }
        }
        XCTAssertEqual(group.wait(timeout: .now() + 5), .success)
    }
}
