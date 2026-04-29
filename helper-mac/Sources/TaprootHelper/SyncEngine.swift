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

// MARK: - Pull wire types (T11.4)

/// Tuple cursor passed in `?since=<iso8601>&since_id=<uuid>` and round-tripped
/// in the response's `next_since` / `next_since_id`. nil on initial pull.
/// Sendable so it can cross actor boundaries (cursor is stored on AppDelegate
/// which is @MainActor; pull executes on the SyncEngine actor).
struct PullCursor: Sendable, Equatable {
    let modifiedAt: String  // ISO8601 string — opaque to the helper, server-defined
    let id: String          // UUID string
}

struct PullFileEntry: Decodable {
    let path: String
    let size: Int
    let mtime: String
    let deleted: Bool
    let content: String?    // plaintext for non-deleted rows (D1.a)
}

struct PullResponseBody: Decodable {
    let files: [PullFileEntry]
    let next_since: String?
    let next_since_id: String?
}

/// Outcome a pull tick reports back to the AppDelegate. Caller uses this to
/// decide whether to (a) advance + persist the cursor and (b) immediately
/// re-fire pull (paginated drain) vs (c) wait for the next interval.
enum PullOutcome: Sendable {
    /// Server returned a full page (== limit). Caller may re-pull
    /// immediately to drain remaining rows (subject to D5 10-page cap).
    case morePages(PullCursor)
    /// Server returned a partial page (< limit) or empty. Caller advances
    /// cursor and waits for the next interval.
    case caughtUp(PullCursor?)
    /// Transport / decode / non-401 error. Cursor unchanged. Caller waits
    /// for the next interval. (401 is handled in-actor via onUnauthorized;
    /// this case is reserved for everything else.)
    case transportError
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

    /// Issues GET /api/sync/pull and applies any returned files/deletes to the
    /// local folder via the supplied `applyWrite` / `applyDelete` callbacks.
    ///
    /// The callbacks run on the @MainActor — they own local FS I/O. The caller
    /// (AppDelegate.pullTick) pauses the watcher around the whole pull burst
    /// (IQ-B echo suppression). Concurrent local edits during the pull window
    /// are lost (FSEventStream resets on restart via kFSEventStreamEventIdSinceNow);
    /// acceptable at 30s cadence.
    ///
    /// Returns a `PullOutcome` so the caller can decide pagination vs sleep.
    /// The cursor inside `.morePages` / `.caughtUp` is the cursor the helper
    /// should persist for next call (NOT necessarily different from the input
    /// cursor — empty pages report null/echo input).
    ///
    /// Stage 1 limitation: write-through. Incoming files overwrite local files
    /// with NO conflict detection. Lock 7 is push-side and partially-wired;
    /// pull-side conflict detection is explicitly out of scope for T11.4.
    func pull(
        workspace: WorkspaceSnapshot,
        cursor: PullCursor?,
        limit: Int = 500,
        applyWrite: @MainActor (URL, String) async -> Void,
        applyDelete: @MainActor (URL) async -> Void
    ) async -> PullOutcome {
        var components = URLComponents(
            url: baseURL.appendingPathComponent("api/sync/pull"),
            resolvingAgainstBaseURL: false
        )!
        var items: [URLQueryItem] = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor {
            items.append(URLQueryItem(name: "since", value: cursor.modifiedAt))
            items.append(URLQueryItem(name: "since_id", value: cursor.id))
        }
        components.queryItems = items
        guard let url = components.url else {
            NSLog("[Taproot] pull: URL build failed")
            return .transportError
        }

        let request = HTTPRequest(
            url: url,
            method: "GET",
            headers: ["Authorization": "Bearer \(workspace.bearer)"],
            body: Data()
        )

        let response: HTTPResponse
        do {
            response = try await httpClient.send(request)
        } catch {
            NSLog("[Taproot] pull: transport error: \(error) — Stage 1 drop, retry next tick")
            return .transportError
        }

        switch response.status {
        case 200..<300:
            break
        case 401:
            NSLog("[Taproot] pull: 401 — signing out workspace \(workspace.id)")
            let id = workspace.id
            let handler = onUnauthorized
            Task { @MainActor in handler(id) }
            return .transportError
        default:
            let bodyStr = String(data: response.body, encoding: .utf8) ?? "<binary>"
            NSLog("[Taproot] pull: HTTP \(response.status) body=\(bodyStr.prefix(200))")
            return .transportError
        }

        let decoded: PullResponseBody
        do {
            decoded = try JSONDecoder().decode(PullResponseBody.self, from: response.body)
        } catch {
            NSLog("[Taproot] pull: decode failed: \(error)")
            return .transportError
        }

        // Apply each entry. AppDelegate.pullTick has already paused the watcher
        // for the whole burst (it owns the watcher; the engine is workspace-blind
        // to the watcher).
        for entry in decoded.files {
            // Path traversal defense — refuse anything that escapes the workspace
            // folder. localFolder is canonicalized by the caller (per §5 invariant).
            guard let target = SyncEngine.safeJoin(folder: workspace.localFolder, relative: entry.path) else {
                NSLog("[Taproot] pull: refusing path-escape: \(entry.path)")
                continue
            }

            if entry.deleted {
                await applyDelete(target)
                continue
            }

            guard let content = entry.content else {
                // Server returned alive entry without inline content — should
                // not happen with D1.a wire format. Skip rather than write empty.
                NSLog("[Taproot] pull: alive entry missing content: \(entry.path)")
                continue
            }
            await applyWrite(target, content)
        }

        // Build cursor from response.
        let nextCursor: PullCursor?
        if let s = decoded.next_since, let i = decoded.next_since_id {
            nextCursor = PullCursor(modifiedAt: s, id: i)
        } else {
            // null/null — only on absolute initial-empty (workspace zero files
            // and helper sent no cursor). Echo input.
            nextCursor = cursor
        }

        if decoded.files.count >= limit, let next = nextCursor {
            return .morePages(next)
        }
        return .caughtUp(nextCursor)
    }

    /// Path-traversal-safe join. Refuses absolute paths and any path with
    /// `..` components. nonisolated — pure function.
    ///
    /// We deliberately do NOT use `URL.standardizedFileURL` for the prefix
    /// check: NSString's `standardizingPath` strips a leading `/private`
    /// component when the resolved path exists on disk — and on macOS
    /// `tmpdir()` lives at `/private/var/folders/...`. That strip happens
    /// asymmetrically (the folder URL keeps `/private`; the target URL drops
    /// it because the resolved path exists), breaking the prefix comparison.
    /// Component-level `..` rejection is the simpler invariant and avoids
    /// the asymmetry entirely.
    nonisolated static func safeJoin(folder: URL, relative: String) -> URL? {
        if relative.hasPrefix("/") { return nil }
        if relative.split(separator: "/").contains("..") { return nil }
        return folder.appendingPathComponent(relative)
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
