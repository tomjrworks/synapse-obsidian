import AppKit
import Foundation

struct Services {
    let keychain: KeychainStore
    let httpClient: HTTPClient
    let baseURL: URL
    let now: () -> Date
    let auth: any AuthService
    let openURL: (URL) -> Void

    /// Memberwise init with defaults for `auth` and `openURL` so existing
    /// test call-sites that only supply the original four fields keep compiling.
    init(
        keychain: KeychainStore,
        httpClient: HTTPClient,
        baseURL: URL,
        now: @escaping () -> Date,
        auth: (any AuthService)? = nil,
        openURL: ((URL) -> Void)? = nil
    ) {
        self.keychain = keychain
        self.httpClient = httpClient
        self.baseURL = baseURL
        self.now = now
        self.auth = auth ?? NoopAuthService()
        self.openURL = openURL ?? { _ in }
    }

    static func production() -> Services {
        let kcService = ProcessInfo.processInfo.environment["TAPROOT_KEYCHAIN_SERVICE"]
            ?? "com.taproot.helper"
        let baseURL = BaseURLResolver.resolve()
        return Services(
            keychain: KeychainStore(service: kcService),
            httpClient: URLSessionHTTPClient(session: .shared),
            baseURL: baseURL,
            now: { Date() },
            auth: SupabaseAuthService(
                httpClient: URLSessionHTTPClient(session: .shared),
                supabaseURL: BaseURLResolver.resolveSupabaseURL(),
                supabaseAnonKey: BaseURLResolver.resolveSupabaseAnonKey(),
                baseURL: baseURL
            ),
            openURL: { url in NSWorkspace.shared.open(url) }
        )
    }
}
