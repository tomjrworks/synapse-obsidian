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
}
