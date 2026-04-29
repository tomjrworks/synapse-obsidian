import Foundation

// MARK: - Wire types

struct PushOp: Encodable {
    enum Kind: String, Encodable {
        case upsert
        case delete
    }

    let kind: Kind
    let path: String
    let content: String?
    let mtime: String?

    enum CodingKeys: String, CodingKey {
        case kind, path, content, mtime
    }

    /// Custom `encode(to:)` so optional fields are omitted (not serialized as
    /// `null`) on the wire. Saves bytes for delete ops which carry only kind+path.
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind, forKey: .kind)
        try container.encode(path, forKey: .path)
        try container.encodeIfPresent(content, forKey: .content)
        try container.encodeIfPresent(mtime, forKey: .mtime)
    }
}

struct PushRequestBody: Encodable {
    let ops: [PushOp]
}

struct PushResultEntry: Decodable {
    let path: String
    let ok: Bool
    let error: String?
    let detail: String?
}

struct PushResponseBody: Decodable {
    let results: [PushResultEntry]
}

/// Plain value snapshot of a workspace, captured on the main actor before being
/// handed to the sync actor. `localFolder` MUST already be symlink-resolved by
/// the caller — see AppDelegate §5 fix and the `testPushHandlesSymlinkedLocalFolder`
/// regression test in `SyncEngineTests`.
struct WorkspaceSnapshot: Sendable {
    let id: UUID
    let bearer: String
    let localFolder: URL
}

// MARK: - SyncEngine

/// Pushes batched `FileChangeEvent`s for a workspace to `POST /api/sync/push`.
///
/// Concurrency:
/// - `actor` isolation guards `onUnauthorized` mutation across threads.
/// - `toOp` is `nonisolated` because it only reads its parameters.
/// - On 401, fires `onUnauthorized(id)` via a `Task { @MainActor }` hop.
///   The handler is captured into a local `let` BEFORE the Task is spawned, so
///   the Task body never reads actor-isolated state — that would require
///   `await self.onUnauthorized` and was the §3.3 contradiction the plan caught.
///
/// Stage 1 semantics: log + drop on transport failure; T11.4 owns retries/queue.
actor SyncEngine {
    private let httpClient: HTTPClient
    private let baseURL: URL
    private var onUnauthorized: @MainActor (UUID) -> Void = { _ in }

    init(httpClient: HTTPClient, baseURL: URL) {
        self.httpClient = httpClient
        self.baseURL = baseURL
    }

    /// Set after init from the AppDelegate's `applicationDidFinishLaunching` to
    /// avoid the init-capture-of-self footgun.
    func setOnUnauthorized(_ handler: @escaping @MainActor (UUID) -> Void) {
        self.onUnauthorized = handler
    }

    func push(workspace: WorkspaceSnapshot, events: [FileChangeEvent]) async {
        guard !events.isEmpty else { return }
        let ops = events.compactMap { toOp(event: $0, localFolder: workspace.localFolder) }
        guard !ops.isEmpty else { return }

        let url = baseURL.appendingPathComponent("api/sync/push")
        let body: Data
        do {
            body = try JSONEncoder().encode(PushRequestBody(ops: ops))
        } catch {
            NSLog("[Taproot] push: encode failed: \(error)")
            return
        }

        let request = HTTPRequest(
            url: url,
            method: "POST",
            headers: [
                "Content-Type": "application/json",
                "Authorization": "Bearer \(workspace.bearer)",
            ],
            body: body
        )

        do {
            let response = try await httpClient.send(request)
            switch response.status {
            case 200..<300:
                if let decoded = try? JSONDecoder().decode(PushResponseBody.self, from: response.body) {
                    for r in decoded.results where !r.ok {
                        NSLog("[Taproot] push: op failed path=\(r.path) error=\(r.error ?? "?") detail=\(r.detail ?? "-")")
                    }
                } else {
                    NSLog("[Taproot] push: 2xx but body decode failed; treating as success")
                }
            case 401:
                NSLog("[Taproot] push: 401 — signing out workspace \(workspace.id)")
                let id = workspace.id
                let handler = onUnauthorized
                Task { @MainActor in handler(id) }
            case 413:
                NSLog("[Taproot] push: 413 — batch too large; dropping (Stage 1, no chunking)")
            default:
                let bodyStr = String(data: response.body, encoding: .utf8) ?? "<binary>"
                NSLog("[Taproot] push: HTTP \(response.status) body=\(bodyStr.prefix(200))")
            }
        } catch {
            NSLog("[Taproot] push: transport error: \(error) — Stage 1 drop, T11.4 retries")
        }
    }

    /// Maps a `FileChangeEvent` to a `PushOp`, relativizing the path against
    /// `localFolder`. Returns nil for paths outside the watched folder, the
    /// folder root itself, or upserts whose file content can't be read (file
    /// vanished mid-coalesce — subsequent FSEvents tick reports the delete).
    nonisolated func toOp(event: FileChangeEvent, localFolder: URL) -> PushOp? {
        let folderPath = localFolder.path.hasSuffix("/") ? localFolder.path : localFolder.path + "/"
        let absPath = event.path.path
        guard absPath.hasPrefix(folderPath) else {
            NSLog("[Taproot] push: dropping event outside watched folder: \(absPath) (folder=\(folderPath))")
            return nil
        }
        let relative = String(absPath.dropFirst(folderPath.count))
        guard !relative.isEmpty else { return nil }

        let mtimeStr = event.mtime.map { ISO8601DateFormatter().string(from: $0) }

        switch event.kind {
        case .deleted:
            return PushOp(kind: .delete, path: relative, content: nil, mtime: nil)
        case .created, .modified:
            guard let data = try? Data(contentsOf: event.path),
                  let content = String(data: data, encoding: .utf8) else {
                NSLog("[Taproot] push: read failed for \(relative); skipping")
                return nil
            }
            return PushOp(kind: .upsert, path: relative, content: content, mtime: mtimeStr)
        }
    }
}
