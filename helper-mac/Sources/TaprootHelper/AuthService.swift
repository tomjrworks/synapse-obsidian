import Foundation

protocol AuthService {
    func signInWithSupabase(email: String, password: String) async -> Result<SupabaseSession, AuthError>
    func mintDeviceBearer(jwt: String, deviceName: String, osPlatform: String) async -> Result<DeviceBearer, AuthError>
}

struct SupabaseSession: Equatable {
    let accessToken: String
    let refreshToken: String
    let userEmail: String
}

struct DeviceBearer: Equatable {
    let bearer: String
    let workspaceID: UUID
    let deviceID: UUID
    let expiresAt: Date
}

enum AuthError: Error {
    case invalidCredentials
    case emailNotConfirmed
    case rateLimited
    case noWorkspace
    case networkError(Error)
    case server(status: Int, message: String?)
}

extension AuthError: Equatable {
    static func == (lhs: AuthError, rhs: AuthError) -> Bool {
        switch (lhs, rhs) {
        case (.invalidCredentials, .invalidCredentials): return true
        case (.emailNotConfirmed, .emailNotConfirmed): return true
        case (.rateLimited, .rateLimited): return true
        case (.noWorkspace, .noWorkspace): return true
        case (.networkError, .networkError): return true
        case (.server(let ls, let lm), .server(let rs, let rm)): return ls == rs && lm == rm
        default: return false
        }
    }
}

/// Noop implementation used as the default in `Services` for contexts that
/// don't need real auth (existing tests, pure-HTTP test suites).
final class NoopAuthService: AuthService {
    func signInWithSupabase(email: String, password: String) async -> Result<SupabaseSession, AuthError> {
        .failure(.server(status: 0, message: "noop"))
    }
    func mintDeviceBearer(jwt: String, deviceName: String, osPlatform: String) async -> Result<DeviceBearer, AuthError> {
        .failure(.server(status: 0, message: "noop"))
    }
}

/// Production auth service: two-hop flow.
/// Hop 1: POST `<supabaseURL>/auth/v1/token?grant_type=password` → Supabase JWT.
/// Hop 2: POST `<baseURL>/api/helper/auth/direct` with JWT → device bearer.
final class SupabaseAuthService: AuthService {
    private let httpClient: HTTPClient
    private let supabaseURL: URL
    private let supabaseAnonKey: String
    private let baseURL: URL

    init(httpClient: HTTPClient, supabaseURL: URL, supabaseAnonKey: String, baseURL: URL) {
        self.httpClient = httpClient
        self.supabaseURL = supabaseURL
        self.supabaseAnonKey = supabaseAnonKey
        self.baseURL = baseURL
    }

    func signInWithSupabase(email: String, password: String) async -> Result<SupabaseSession, AuthError> {
        var comps = URLComponents(
            url: supabaseURL.appendingPathComponent("auth/v1/token"),
            resolvingAgainstBaseURL: false
        )!
        comps.queryItems = [URLQueryItem(name: "grant_type", value: "password")]
        guard let url = comps.url else {
            return .failure(.server(status: 0, message: "URL construction failed"))
        }
        guard let body = try? JSONSerialization.data(withJSONObject: ["email": email, "password": password]) else {
            return .failure(.server(status: 0, message: "Encoding failed"))
        }
        let req = HTTPRequest(
            url: url,
            method: "POST",
            headers: ["apikey": supabaseAnonKey, "Content-Type": "application/json"],
            body: body
        )
        do {
            let resp = try await httpClient.send(req)
            if resp.status == 429 { return .failure(.rateLimited) }
            guard resp.status == 200 else {
                let json = (try? JSONSerialization.jsonObject(with: resp.body)) as? [String: Any]
                let desc = (json?["error_description"] as? String) ?? ""
                if desc.contains("Email not confirmed") { return .failure(.emailNotConfirmed) }
                return .failure(.invalidCredentials)
            }
            guard
                let json = (try? JSONSerialization.jsonObject(with: resp.body)) as? [String: Any],
                let accessToken = json["access_token"] as? String,
                let refreshToken = json["refresh_token"] as? String,
                let userDict = json["user"] as? [String: Any],
                let userEmail = userDict["email"] as? String
            else {
                return .failure(.server(status: resp.status, message: "Malformed response"))
            }
            return .success(SupabaseSession(accessToken: accessToken, refreshToken: refreshToken, userEmail: userEmail))
        } catch {
            return .failure(.networkError(error))
        }
    }

    func mintDeviceBearer(jwt: String, deviceName: String, osPlatform: String) async -> Result<DeviceBearer, AuthError> {
        let url = baseURL.appendingPathComponent("api/helper/auth/direct")
        guard let body = try? JSONSerialization.data(withJSONObject: ["device_name": deviceName, "os_platform": osPlatform]) else {
            return .failure(.server(status: 0, message: "Encoding failed"))
        }
        let req = HTTPRequest(
            url: url,
            method: "POST",
            headers: ["Authorization": "Bearer \(jwt)", "Content-Type": "application/json"],
            body: body
        )
        do {
            let resp = try await httpClient.send(req)
            if resp.status == 429 { return .failure(.rateLimited) }
            if resp.status == 404 { return .failure(.noWorkspace) }
            guard resp.status == 200 else {
                return .failure(.server(status: resp.status, message: nil))
            }
            guard
                let json = (try? JSONSerialization.jsonObject(with: resp.body)) as? [String: Any],
                let bearer = json["bearer"] as? String,
                let wsStr = json["workspace_id"] as? String,
                let workspaceID = UUID(uuidString: wsStr),
                let deviceStr = json["device_id"] as? String,
                let deviceID = UUID(uuidString: deviceStr),
                let expiresStr = json["expires_at"] as? String
            else {
                return .failure(.server(status: resp.status, message: "Malformed response"))
            }
            let expiresAt = ISO8601DateFormatter().date(from: expiresStr) ?? .distantFuture
            return .success(DeviceBearer(
                bearer: bearer,
                workspaceID: workspaceID,
                deviceID: deviceID,
                expiresAt: expiresAt
            ))
        } catch {
            return .failure(.networkError(error))
        }
    }
}
