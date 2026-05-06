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

    /// Resolves the Supabase project URL. Order: env override > Info.plist.
    /// Crashes loudly if neither is set — the helper cannot authenticate without it.
    static func resolveSupabaseURL(
        env: [String: String] = ProcessInfo.processInfo.environment,
        bundleLookup: (String) -> Any? = { Bundle.main.object(forInfoDictionaryKey: $0) }
    ) -> URL {
        if let raw = env["TAPROOT_SUPABASE_URL"],
           let url = URL(string: raw),
           url.scheme == "http" || url.scheme == "https" {
            return url
        }
        if let raw = bundleLookup("TaprootSupabaseURL") as? String,
           let url = URL(string: raw),
           url.scheme == "http" || url.scheme == "https" {
            return url
        }
        fatalError("TaprootSupabaseURL not set in Info.plist or TAPROOT_SUPABASE_URL env")
    }

    /// Resolves the Supabase anon key. Order: env override > Info.plist.
    /// Crashes loudly if neither is set — the helper cannot authenticate without it.
    /// The anon key is public-by-design (RLS protects data, not the key).
    static func resolveSupabaseAnonKey(
        env: [String: String] = ProcessInfo.processInfo.environment,
        bundleLookup: (String) -> Any? = { Bundle.main.object(forInfoDictionaryKey: $0) }
    ) -> String {
        if let raw = env["TAPROOT_SUPABASE_ANON_KEY"], !raw.isEmpty {
            return raw
        }
        if let raw = bundleLookup("TaprootSupabaseAnonKey") as? String, !raw.isEmpty {
            return raw
        }
        fatalError("TaprootSupabaseAnonKey not set in Info.plist or TAPROOT_SUPABASE_ANON_KEY env")
    }
}
