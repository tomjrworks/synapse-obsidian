import Foundation
@testable import TaprootHelper

/// Thread-safe stub for `AuthService`. Implemented as an `actor` to match the
/// `FakeHTTPClient` pattern — async callers on `@MainActor` use `await` to
/// read/write state without data races.
actor FakeAuthService: AuthService {
    private(set) var signInCallCount = 0
    private(set) var mintCallCount = 0
    private(set) var lastSignInEmail: String?
    private(set) var lastSignInPassword: String?
    private(set) var lastMintJWT: String?
    private(set) var lastMintDeviceName: String?
    private(set) var lastMintOSPlatform: String?

    private var stubbedSignIn: Result<SupabaseSession, AuthError> = .success(
        SupabaseSession(
            accessToken: "stub-jwt",
            refreshToken: "stub-refresh",
            userEmail: "stub@example.com"
        )
    )
    private var stubbedMint: Result<DeviceBearer, AuthError>

    init(workspaceID: UUID = UUID(), bearer: String = "stub-device-bearer") {
        stubbedMint = .success(DeviceBearer(
            bearer: bearer,
            workspaceID: workspaceID,
            deviceID: UUID(),
            expiresAt: .distantFuture
        ))
    }

    func setStubbedSignIn(_ result: Result<SupabaseSession, AuthError>) {
        stubbedSignIn = result
    }

    func setStubbedMint(_ result: Result<DeviceBearer, AuthError>) {
        stubbedMint = result
    }

    func signInWithSupabase(email: String, password: String) async -> Result<SupabaseSession, AuthError> {
        signInCallCount += 1
        lastSignInEmail = email
        lastSignInPassword = password
        return stubbedSignIn
    }

    func mintDeviceBearer(jwt: String, deviceName: String, osPlatform: String) async -> Result<DeviceBearer, AuthError> {
        mintCallCount += 1
        lastMintJWT = jwt
        lastMintDeviceName = deviceName
        lastMintOSPlatform = osPlatform
        return stubbedMint
    }
}
