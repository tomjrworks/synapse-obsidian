import Foundation

/// Helper-wide tunables. Centralized here so call sites read a single,
/// documented source.
enum Constants {
    /// S82 — per-file cap for sync read paths. Files larger than this are
    /// skipped (not synced) and surfaced via `LargeFileSkipTracker`.
    /// Matches PRODUCT's `TAPROOT_FETCH_MAX_BYTES`.
    static let MAX_FILE_BYTES: Int64 = 50 * 1024 * 1024
}
