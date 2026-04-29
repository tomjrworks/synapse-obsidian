import Foundation

enum BaseURLResolver {
    static let defaultURL = URL(string: "https://connect.taproothq.com")!

    /// Order: env override > Info.plist > hardcoded default. Scheme-validate to
    /// {http, https} so a malformed plist value (e.g., shipped with `taproot://`
    /// by mistake) falls through instead of breaking runtime silently.
    static func resolve(
        env: [String: String] = ProcessInfo.processInfo.environment,
        bundleLookup: (String) -> Any? = { Bundle.main.object(forInfoDictionaryKey: $0) }
    ) -> URL {
        if let raw = env["TAPROOT_BASE_URL"],
           let url = URL(string: raw),
           url.scheme == "http" || url.scheme == "https" {
            return url
        }
        if let raw = bundleLookup("TaprootBaseURL") as? String,
           let url = URL(string: raw),
           url.scheme == "http" || url.scheme == "https" {
            return url
        }
        return defaultURL
    }
}
