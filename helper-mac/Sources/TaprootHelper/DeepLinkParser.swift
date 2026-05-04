import Foundation

/// Parsed `taproot://auth?code=<hex64>&workspace=<uuid>` deep link.
///
/// Carries a 5-minute single-use auth code (NOT a bearer). The helper
/// exchanges this code for a bearer at `POST /signin/exchange` with
/// proof of the matching PKCE verifier. See B1 fix:
/// /Users/miloman/.claude/plans/cosmic-gathering-lark.md.
struct AuthDeepLink: Equatable {
    let code: String
    let workspaceID: UUID
}

/// Parsed `taproot://pair?code=TAP-XXXX-XXXX` deep link (Bundle 6).
///
/// Carries a 10-min single-use pair code. The helper redeems this at
/// `POST /api/helper/pair/redeem` to receive a bearer — no PKCE round-trip.
struct PairDeepLink: Equatable {
    let code: String  // canonical uppercase "TAP-XXXX-XXXX"
}

enum DeepLinkParseError: Error, Equatable {
    case wrongScheme
    case wrongHost
    case missingCode
    case invalidCode
    case missingWorkspace
    case invalidWorkspaceUUID
}

enum DeepLinkParser {
    /// Parses `taproot://auth?code=<hex64>&workspace=<uuid>`.
    ///
    /// Per RFC 3986 §3.1, URL schemes are case-insensitive and `URL` normalizes
    /// them to lowercase, so `url.scheme == "taproot"` is robust without a
    /// `.lowercased()` call. Hosts are also case-insensitive but `url.host`
    /// preserves the original casing, so we lowercase explicitly.
    ///
    /// `code` matches the server format (`randomBytes(32).toString("hex")`) —
    /// exactly 64 lowercase hex characters. Anything else is rejected so a
    /// malformed link can't reach the exchange endpoint.
    static func parseAuth(_ url: URL) throws -> AuthDeepLink {
        guard url.scheme == "taproot" else { throw DeepLinkParseError.wrongScheme }
        guard url.host?.lowercased() == "auth" else { throw DeepLinkParseError.wrongHost }

        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []

        guard let code = items.first(where: { $0.name == "code" })?.value,
              !code.isEmpty else {
            throw DeepLinkParseError.missingCode
        }
        let hexCharset = CharacterSet(charactersIn: "0123456789abcdef")
        guard code.count == 64,
              code.unicodeScalars.allSatisfy({ hexCharset.contains($0) }) else {
            throw DeepLinkParseError.invalidCode
        }
        guard let workspaceStr = items.first(where: { $0.name == "workspace" })?.value,
              !workspaceStr.isEmpty else {
            throw DeepLinkParseError.missingWorkspace
        }
        guard let workspaceID = UUID(uuidString: workspaceStr) else {
            throw DeepLinkParseError.invalidWorkspaceUUID
        }
        return AuthDeepLink(code: code, workspaceID: workspaceID)
    }

    /// Parses `taproot://pair?code=TAP-XXXX-XXXX`.
    ///
    /// Accepts any case and optional dash omission — `canonicalizePairCode`
    /// normalizes to uppercase canonical form before returning. Invalid shapes
    /// are rejected so malformed links can't reach the redeem endpoint.
    static func parsePair(_ url: URL) throws -> PairDeepLink {
        guard url.scheme == "taproot" else { throw DeepLinkParseError.wrongScheme }
        guard url.host?.lowercased() == "pair" else { throw DeepLinkParseError.wrongHost }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard let raw = items.first(where: { $0.name == "code" })?.value,
              !raw.isEmpty else {
            throw DeepLinkParseError.missingCode
        }
        guard let canonical = canonicalizePairCode(raw) else {
            throw DeepLinkParseError.invalidCode
        }
        return PairDeepLink(code: canonical)
    }

    /// Normalizes a raw pair code to canonical uppercase "TAP-XXXX-XXXX" form,
    /// or returns nil if the input is invalid. Accepts case variants and
    /// omitted dashes (e.g. "tap3k7mAB2C" → "TAP-3K7M-AB2C").
    ///
    /// Alphabet: A-Z minus I, O, U; digits 2-9 (Crockford-inspired, avoids
    /// visual confusion with 0/1/I/O). Matches server CODE_REGEX
    /// [A-HJ-NP-TV-Z2-9]{4}-[A-HJ-NP-TV-Z2-9]{4}.
    static func canonicalizePairCode(_ raw: String) -> String? {
        let stripped = raw.trimmingCharacters(in: .whitespaces)
            .uppercased()
            .replacingOccurrences(of: "-", with: "")
        guard stripped.count == 11, stripped.hasPrefix("TAP") else { return nil }
        let body = String(stripped.dropFirst(3))
        let charset = CharacterSet(charactersIn: "ABCDEFGHJKLMNPQRSTVWXYZ23456789")
        guard body.unicodeScalars.allSatisfy({ charset.contains($0) }) else { return nil }
        return "TAP-\(body.prefix(4))-\(body.suffix(4))"
    }
}
