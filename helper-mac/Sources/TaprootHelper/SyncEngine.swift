import Foundation
import os.lock
import Sentry

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
    /// PR #2 (S99) — server reports "row alive, blob within grace window" so the
    /// helper MUST skip the local apply (do not write, do not delete). Server
    /// recovers on a later pull (delivers content if blob lands, emits deleted
    /// if grace expires). Optional for forward-compat against older servers
    /// (nil decodes to "not pending").
    let pending: Bool?
}

struct PullResponseBody: Decodable {
    let files: [PullFileEntry]
    let next_since: String?
    let next_since_id: String?
    let pending_count: Int?   // rows remaining after this page; nil on old server versions
}

/// Outcome a pull tick reports back to the AppDelegate. Caller uses this to
/// decide whether to (a) advance + persist the cursor and (b) immediately
/// re-fire pull (paginated drain) vs (c) wait for the next interval.
enum PullOutcome: Sendable {
    /// Server returned a full page (== limit). Caller may re-pull
    /// immediately to drain remaining rows (subject to D5 10-page cap).
    /// The Int is `pending_count` from the server — rows still behind after this page.
    case morePages(PullCursor, Int)
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
/// Stage 1 semantics: log + drop on transport failure; eventual consistency
/// via the next pull tick / FSEvent. Retry/queue layer deferred — add only if
/// telemetry shows transport-loss matters in practice.
actor SyncEngine {
    private let httpClient: HTTPClient
    private let baseURL: URL
    private var onUnauthorized: @MainActor (UUID) -> Void = { _ in }

    /// V3 + F2: swift-atomics is not transitive (Sparkle declares no deps),
    /// so a stdlib `OSAllocatedUnfairLock`-protected `Int32` provides the
    /// sync read Sparkle's relaunch postpone hook needs across the actor
    /// boundary. The lock is `nonisolated` so reads from MainActor / any
    /// thread don't require an `await`.
    private nonisolated let pushInFlightLock = OSAllocatedUnfairLock<Int32>(initialState: 0)

    /// Count of in-flight pushes. Readable from any thread / MainActor
    /// without `await`. Sparkle's `shouldPostponeRelaunchForUpdate` polls
    /// this synchronously every 2s during a pending update.
    nonisolated var pushInFlight: Int32 {
        pushInFlightLock.withLock { $0 }
    }

    /// Bumps `pushInFlight`. Used by `InitialSyncCoordinator` to hold the
    /// gate for the duration of a multi-batch initial sync — see the comment
    /// on `pushInFlightLock` and the InitialSyncCoordinator preamble.
    nonisolated func incrementPushInFlight() {
        pushInFlightLock.withLock { $0 += 1 }
    }

    /// Decrements `pushInFlight`. Symmetric with `incrementPushInFlight`;
    /// callers MUST decrement once per increment (use `defer`).
    nonisolated func decrementPushInFlight() {
        pushInFlightLock.withLock { $0 -= 1 }
    }

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
        let ops = events.compactMap { toOp(event: $0, localFolder: workspace.localFolder, workspaceID: workspace.id) }
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

        // pushInFlight bumps span only the network round-trip — not the
        // early-returns above (no events / encode failed). Defer guarantees
        // symmetric decrement on every exit path (success, 401, 413,
        // transport throw).
        pushInFlightLock.withLock { $0 += 1 }
        defer { pushInFlightLock.withLock { $0 -= 1 } }

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
            NSLog("[Taproot] push: transport error: \(error) — drop, eventual consistency via next FSEvent")
            SentrySDK.capture(error: error)
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
            SentrySDK.capture(error: error)
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

            // PR #2 (S99): server signals the blob is plausibly still being
            // uploaded (row exists, blob missing, modified_at within grace
            // window). Skip locally — do NOT write, do NOT delete. The
            // next pull either delivers content (blob landed) or emits
            // deleted: true (grace expired). This closes the cross-device
            // ghost-delete race in PRODUCT writeFile.
            if entry.pending == true {
                NSLog("[Taproot] pull: pending blob for \(entry.path), skipping; server will re-offer on next tick")
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
            return .morePages(next, decoded.pending_count ?? 0)
        }
        return .caughtUp(nextCursor)
    }

    /// Fetches the DB-head cursor from `GET /api/sync/cursor-head`. Called once
    /// immediately after initial sync completes so the first pullTick starts at
    /// head (no re-download of all just-pushed files). Returns nil on transport
    /// error or if the workspace is empty — caller treats nil as "no cursor"
    /// (safe: first pull becomes an initial pull, same as today).
    func fetchCursorHead(workspace: WorkspaceSnapshot) async -> PullCursor? {
        let url = baseURL.appendingPathComponent("api/sync/cursor-head")
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
            NSLog("[Taproot] fetchCursorHead: transport error: \(error)")
            return nil
        }
        guard (200..<300).contains(response.status) else {
            NSLog("[Taproot] fetchCursorHead: HTTP \(response.status)")
            return nil
        }
        struct CursorHeadBody: Decodable {
            let next_since: String?
            let next_since_id: String?
        }
        do {
            let body = try JSONDecoder().decode(CursorHeadBody.self, from: response.body)
            if let s = body.next_since, let i = body.next_since_id {
                return PullCursor(modifiedAt: s, id: i)
            }
        } catch {
            NSLog("[Taproot] fetchCursorHead: decode failed: \(error)")
        }
        return nil
    }

    /// Blocker 1 — between-tick "X files behind" visibility. Helper calls this
    /// at the start of each pullTick BEFORE flipping to .syncing so the menu
    /// reflects pending state during the 30s idle window. Returns nil when
    /// `cursor == nil` (no baseline) or on transport error or non-2xx —
    /// caller treats nil as "don't update pendingCount" (existing value
    /// preserved). Always-0 server response (rollback gate via
    /// `PENDING_COUNT_DISABLED=1` on Railway) decodes to 0; menu just stays
    /// on "Synced", same as today's behavior.
    func fetchPendingCount(workspace: WorkspaceSnapshot, cursor: PullCursor?) async -> Int? {
        guard let cursor else { return nil }
        var components = URLComponents(
            url: baseURL.appendingPathComponent("api/sync/pending-count"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [
            URLQueryItem(name: "since", value: cursor.modifiedAt),
            URLQueryItem(name: "since_id", value: cursor.id),
        ]
        guard let url = components?.url else { return nil }
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
            NSLog("[Taproot] fetchPendingCount: transport error: \(error)")
            return nil
        }
        guard (200..<300).contains(response.status) else {
            NSLog("[Taproot] fetchPendingCount: HTTP \(response.status)")
            return nil
        }
        struct PendingCountBody: Decodable {
            let pending_count: Int
        }
        do {
            let body = try JSONDecoder().decode(PendingCountBody.self, from: response.body)
            return body.pending_count
        } catch {
            NSLog("[Taproot] fetchPendingCount: decode failed: \(error)")
            return nil
        }
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
        let target = folder.appendingPathComponent(relative)
        // S96: refuse if any existing ancestor of `target` (inclusive of
        // intermediate directories under `folder`) is a symbolic link.
        // A symlinked component would let a remote pull rewrite arbitrary
        // files outside the vault via the helper's bearer.
        if SyncEngine.pathContainsSymlink(under: folder, target: target, includeTarget: false) {
            return nil
        }
        return target
    }

    /// S96 — walks every existing path component between `under` (exclusive)
    /// and `target`. Returns `true` if any of those components, OR `target`
    /// itself when `includeTarget=true`, is a symbolic link. Used by
    /// `safeJoin` (intermediate-component check) AND `writeFileWithMkdir`
    /// (leaf + intermediate check before any mkdir/write).
    nonisolated static func pathContainsSymlink(under root: URL, target: URL, includeTarget: Bool) -> Bool {
        let rootPath = root.path.hasSuffix("/") ? root.path : root.path + "/"
        let targetPath = target.path
        guard targetPath.hasPrefix(rootPath) else {
            // Target is outside `root` — let the caller handle. This helper is
            // purely about symlink-in-ancestor checks.
            return false
        }
        let relative = String(targetPath.dropFirst(rootPath.count))
        let components = relative.split(separator: "/")
        let ancestorComponents = includeTarget ? components : components.dropLast()
        var probe = root
        for component in ancestorComponents {
            probe.appendPathComponent(String(component))
            if let res = try? probe.resourceValues(forKeys: [.isSymbolicLinkKey]),
               res.isSymbolicLink == true {
                return true
            }
        }
        return false
    }

    /// Errors surfaced by `pushBatch` to the `InitialSyncCoordinator`. Maps
    /// the same status branches `push()` handles internally to typed cases so
    /// the coordinator can decide retry-vs-halve-vs-propagate per batch.
    enum BatchError: Error, Sendable {
        case unauthorized
        case payloadTooLarge
        case http(Int)
        case transport(any Error)
        case encodingFailed(any Error)
    }

    /// Pre-built-ops sibling of `push(workspace:events:)`. Used by
    /// `InitialSyncCoordinator` which builds ops from a directory walk rather
    /// than FSEvents. Reuses the same wire format, request signing, and
    /// 401 onUnauthorized hook; deliberately does NOT touch
    /// `pushInFlightLock` — the coordinator holds the gate for the whole
    /// multi-batch run (per-batch toggling would race Sparkle's relaunch
    /// postpone hook).
    func pushBatch(workspace: WorkspaceSnapshot, ops: [PushOp]) async throws -> [PushResultEntry] {
        guard !ops.isEmpty else { return [] }

        let url = baseURL.appendingPathComponent("api/sync/push")
        let body: Data
        do {
            body = try JSONEncoder().encode(PushRequestBody(ops: ops))
        } catch {
            throw BatchError.encodingFailed(error)
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

        let response: HTTPResponse
        do {
            response = try await httpClient.send(request)
        } catch {
            throw BatchError.transport(error)
        }

        switch response.status {
        case 200..<300:
            if let decoded = try? JSONDecoder().decode(PushResponseBody.self, from: response.body) {
                for r in decoded.results where !r.ok {
                    NSLog("[Taproot] pushBatch: op failed path=\(r.path) error=\(r.error ?? "?") detail=\(r.detail ?? "-")")
                }
                return decoded.results
            }
            NSLog("[Taproot] pushBatch: 2xx but body decode failed; treating as success")
            return []
        case 401:
            NSLog("[Taproot] pushBatch: 401 — signing out workspace \(workspace.id)")
            let id = workspace.id
            let handler = onUnauthorized
            Task { @MainActor in handler(id) }
            throw BatchError.unauthorized
        case 413:
            NSLog("[Taproot] pushBatch: 413 — caller will halve and retry")
            throw BatchError.payloadTooLarge
        default:
            let bodyStr = String(data: response.body, encoding: .utf8) ?? "<binary>"
            NSLog("[Taproot] pushBatch: HTTP \(response.status) body=\(bodyStr.prefix(200))")
            throw BatchError.http(response.status)
        }
    }

    /// Maps a `FileChangeEvent` to a `PushOp`, relativizing the path against
    /// `localFolder`. Returns nil for paths outside the watched folder, the
    /// folder root itself, or upserts whose file content can't be read (file
    /// vanished mid-coalesce — subsequent FSEvents tick reports the delete).
    nonisolated func toOp(event: FileChangeEvent, localFolder: URL, workspaceID: UUID) -> PushOp? {
        let folderPath = localFolder.path.hasSuffix("/") ? localFolder.path : localFolder.path + "/"
        let absPath = event.path.path
        guard absPath.hasPrefix(folderPath) else {
            NSLog("[Taproot] push: dropping event outside watched folder: \(absPath) (folder=\(folderPath))")
            return nil
        }
        let relative = String(absPath.dropFirst(folderPath.count))
        guard !relative.isEmpty else { return nil }

        // N3: defense-in-depth — defer to pull's safeJoin invariant. FSEvents
        // canonicalizes paths so a `..` traversal is unlikely in practice, but
        // symmetric validation closes the gap if a future code path ever feeds
        // non-canonical events into toOp.
        guard SyncEngine.safeJoin(folder: localFolder, relative: relative) != nil else {
            NSLog("[Taproot] push: refusing path-escape after relativize: \(relative)")
            return nil
        }

        let mtimeStr = event.mtime.map { ISO8601DateFormatter().string(from: $0) }

        switch event.kind {
        case .deleted:
            return PushOp(kind: .delete, path: relative, content: nil, mtime: nil)
        case .created, .modified:
            // S82: refuse to read files larger than MAX_FILE_BYTES. Record in
            // the tracker so the menubar can surface "· N skipped" and the
            // one-shot NSAlert fires from the post-push tick.
            if let res = try? event.path.resourceValues(forKeys: [.fileSizeKey]),
               let size = res.fileSize,
               Int64(size) > Constants.MAX_FILE_BYTES {
                LargeFileSkipTracker.shared.record(workspace: workspaceID, path: relative, size: Int64(size))
                return nil
            }
            guard let data = try? Data(contentsOf: event.path),
                  let content = String(data: data, encoding: .utf8) else {
                NSLog("[Taproot] push: read failed for \(relative); skipping")
                return nil
            }
            return PushOp(kind: .upsert, path: relative, content: content, mtime: mtimeStr)
        }
    }
}
