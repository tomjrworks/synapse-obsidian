import Foundation

struct AuthDeepLink: Equatable {
    let bearer: String
    let workspaceID: UUID
}

enum DeepLinkParseError: Error, Equatable {
    case wrongScheme
    case wrongHost
    case missingBearer
    case missingWorkspace
    case invalidWorkspaceUUID
}

enum DeepLinkParser {
    /// Parses `taproot://auth?bearer=<token>&workspace=<uuid>`.
    ///
    /// Per RFC 3986 §3.1, URL schemes are case-insensitive and `URL` normalizes
    /// them to lowercase, so `url.scheme == "taproot"` is robust without a
    /// `.lowercased()` call. Hosts are also case-insensitive but `url.host`
    /// preserves the original casing, so we lowercase explicitly.
    static func parseAuth(_ url: URL) throws -> AuthDeepLink {
        guard url.scheme == "taproot" else { throw DeepLinkParseError.wrongScheme }
        guard url.host?.lowercased() == "auth" else { throw DeepLinkParseError.wrongHost }

        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []

        guard let bearer = items.first(where: { $0.name == "bearer" })?.value,
              !bearer.isEmpty else {
            throw DeepLinkParseError.missingBearer
        }
        guard let workspaceStr = items.first(where: { $0.name == "workspace" })?.value,
              !workspaceStr.isEmpty else {
            throw DeepLinkParseError.missingWorkspace
        }
        guard let workspaceID = UUID(uuidString: workspaceStr) else {
            throw DeepLinkParseError.invalidWorkspaceUUID
        }
        return AuthDeepLink(bearer: bearer, workspaceID: workspaceID)
    }
}
