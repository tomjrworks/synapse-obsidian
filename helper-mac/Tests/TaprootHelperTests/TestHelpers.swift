import Foundation
@testable import TaprootHelper

/// Test fake for `HTTPClient` with thread-safe state capture and stubbed responses.
///
/// Lifted from inline-private in `AppDelegateTests` (commit 2 minimal fake) once
/// commit 3 needed it from both `SyncEngineTests` and `AppDelegateTests`.
///
/// Implemented as an `actor` rather than `final class + NSLock` because async
/// callers (SyncEngine) would surface NSLock-from-async warnings under Swift 6.
/// All reads from test bodies use `await`.
actor FakeHTTPClient: HTTPClient {
    private(set) var firstRequest: HTTPRequest?
    private(set) var lastRequest: HTTPRequest?
    private(set) var sendCount: Int = 0
    private var stubbedResponse: Result<HTTPResponse, Error> =
        .success(HTTPResponse(status: 200, body: Data()))
    private var onSend: (@Sendable () -> Void)?

    func setStubbedResponse(_ result: Result<HTTPResponse, Error>) {
        stubbedResponse = result
    }

    /// Fires synchronously after the send is recorded and before the response
    /// is returned. Useful for fulfilling `XCTestExpectation`s in async tests.
    func setOnSend(_ handler: @escaping @Sendable () -> Void) {
        onSend = handler
    }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        if firstRequest == nil { firstRequest = request }
        lastRequest = request
        sendCount += 1
        let stub = stubbedResponse
        let handler = onSend
        onSend = nil
        handler?()
        return try stub.get()
    }
}
