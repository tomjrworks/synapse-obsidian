import Foundation
import CryptoKit

/// In-memory PKCE verifier storage. One in-flight signin attempt at a
/// time — most-recent-wins if the user starts multiple signin flows.
/// Stage 1 single-user UX accepts this trade-off.
///
/// Verifier never crosses a process boundary; the helper holds it from
/// `beginSignin()` (called when the user clicks Connect) through
/// `consumeVerifier()` (called when the `taproot://` deep-link arrives
/// with the auth code). Then it's discarded — single-use.
final class PKCEStore {
    private var pendingVerifier: String?
    private let queue = DispatchQueue(label: "com.taproot.pkcestore")

    /// Generate a 32-byte random verifier (43-char base64url, RFC 7636
    /// §4.1) and the matching SHA-256 challenge. Stores the verifier for
    /// later retrieval. Returns (challenge, method) for use in the
    /// `<baseURL>/signin?code_challenge=...&code_challenge_method=...`
    /// query string.
    @discardableResult
    func beginSignin() -> (challenge: String, method: String) {
        let verifierBytes = (0..<32).map { _ in UInt8.random(in: 0...255) }
        let verifier = Data(verifierBytes).base64URLEncodedString()
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8)))
            .base64URLEncodedString()
        queue.sync { self.pendingVerifier = verifier }
        return (challenge, "S256")
    }

    /// Consume the pending verifier (one-shot). Returns nil if no signin
    /// flow is in flight — caller should surface a "no active sign-in"
    /// message and tell the user to click Connect again.
    func consumeVerifier() -> String? {
        queue.sync {
            let v = self.pendingVerifier
            self.pendingVerifier = nil
            return v
        }
    }
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
