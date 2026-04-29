import Foundation

struct Services {
    let keychain: KeychainStore
    let httpClient: HTTPClient
    let baseURL: URL
    let now: () -> Date

    static func production() -> Services {
        let kcService = ProcessInfo.processInfo.environment["TAPROOT_KEYCHAIN_SERVICE"]
            ?? "com.taproot.helper"
        return Services(
            keychain: KeychainStore(service: kcService),
            httpClient: URLSessionHTTPClient(session: .shared),
            baseURL: BaseURLResolver.resolve(),
            now: { Date() }
        )
    }
}
