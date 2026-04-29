import Foundation

struct HTTPRequest {
    let url: URL
    let method: String
    let headers: [String: String]
    let body: Data
}

struct HTTPResponse {
    let status: Int
    let body: Data
}

protocol HTTPClient {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse
}

struct URLSessionHTTPClient: HTTPClient {
    let session: URLSession

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        var u = URLRequest(url: request.url)
        u.httpMethod = request.method
        u.httpBody = request.body
        for (k, v) in request.headers { u.setValue(v, forHTTPHeaderField: k) }
        u.timeoutInterval = 30
        let (data, resp) = try await session.data(for: u)
        guard let http = resp as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        return HTTPResponse(status: http.statusCode, body: data)
    }
}
