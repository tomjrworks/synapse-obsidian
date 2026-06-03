/**
 * Stage 1 T4 — SupabaseEncryptedMirrorBackend
 *
 * Server-decryptable envelope encryption with per-tenant DEK. Replaces the
 * (now deleted) GoogleDriveBackend as the cloud-side StorageBackend.
 *
 * Architecture:
 *   - Per-workspace AES-256-GCM DEK, wrapped with KEK from Cloudflare Secrets.
 *   - DEK is unwrapped once at backend construction and held in memory for the
 *     request lifetime. Plaintext never persists on Taproot servers.
 *   - vault_files holds metadata (path, plaintext size, sha256, mtime).
 *   - Supabase Storage bucket `vault-blobs` holds ciphertext at
 *     `{workspace_id}/{vault_files.id}` — keyed by file_id, not path, so renames
 *     don't re-upload.
 *   - audit_log gets a `kek_unwrap` row on every backend construction.
 *
 * Sub-task progression (see canonical plan):
 *   T4.0 — this scaffold + content crypto helpers + typed errors    ← here
 *   T4.1 — forWorkspace factory + DEK unwrap + audit_log write
 *   T4.2 — writeFile (encrypt + upload + UPSERT vault_files)
 *   T4.3 — readFile (download + decrypt)
 *   T4.4 — listFiles / exists / stat / recentFiles (read-only metadata)
 *   T4.5 — delete (soft) / move (path rename) / mkdir (no-op)
 *   T4.6 — nukeWorkspace (Leave Taproot end-to-end)
 *   T4.7 — backend cache primitive
 *   T4.8 — integration smoke against taproot-dev
 *
 * See [[projects/synapse/2026-04-27-taproot-stage1-t4-subtask-plan]] for contracts.
 */
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  FileMeta,
  FileStat,
  ListChangedResult,
  PullCursor,
  StorageBackend,
  VaultFileChange,
} from "./storage.js";
import { ConflictError, NotFoundError } from "./storage.js";
import {
  enrichCardinalitySummary,
  extractCardinality,
  extractTokens,
  type Cardinality,
  type FileTokens,
} from "./frontmatter.js";
import { supabaseService } from "../api/supabase.js";
import { decryptBlob, encryptBlob, unwrapDek } from "../api/crypto.js";
import {
  computeFlagsUpdate,
  getRulesForBackend,
  invalidateRulesCache,
  mergeFlags,
  type FlagsUpdate,
} from "./drift.js";
import { invalidateIndexForWorkspace } from "../tools/index-tool.js";
import { withRetry } from "./retry.js";

const TRANSIENT_HTTP_STATUSES = [429, 500, 502, 503, 504];

function isTransientHttpStatus(status: unknown): boolean {
  if (status === undefined || status === null) return false;
  return TRANSIENT_HTTP_STATUSES.includes(Number(status));
}

const VAULT_BLOBS_BUCKET = "vault-blobs";
const PG_UNIQUE_VIOLATION = "23505";

// PR #2 (S99): grace window for "row exists, blob missing" classification.
// A row whose blob 404s but whose modified_at is fresher than this window
// is treated as a pending in-flight upload (helper skips locally); older
// rows are treated as stale orphans (legacy deleted: true cleanup path).
// Default 60s — multiple orders of magnitude greater than the largest
// realistic blob upload latency. Tunable via env.
const MISSING_BLOB_GRACE_MS_DEFAULT = 60_000;
function missingBlobGraceMs(): number {
  const raw = process.env.MISSING_BLOB_GRACE_MS;
  if (!raw) return MISSING_BLOB_GRACE_MS_DEFAULT;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 0) return MISSING_BLOB_GRACE_MS_DEFAULT;
  return n;
}

// PR #2 kill switch: reverts listChanged classification, nukeWorkspace
// order, and writeFile order to pre-PR-#2 production behavior. Single env
// flip for full rollback. Delete one release after deploy if no rollback.
function legacyMissingBlobBehavior(): boolean {
  return process.env.MISSING_BLOB_LEGACY_BEHAVIOR === "1";
}

// Postgres bytea columns come back from PostgREST as `\x...hex...` strings.
// (Older Supabase configs may use base64; handle both for resilience.)
function bytesFromPg(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") {
    if (value.startsWith("\\x")) return Buffer.from(value.slice(2), "hex");
    return Buffer.from(value, "base64");
  }
  throw new Error(
    `Unexpected bytea value type: ${typeof value} (constructor: ${(value as object | null)?.constructor?.name ?? "null"})`,
  );
}

export class SupabaseEncryptedMirrorBackend implements StorageBackend {
  constructor(
    private supabase: SupabaseClient,
    readonly workspaceId: string,
    private dek: Buffer,
  ) {}

  // Resolve a workspace's encrypted-mirror backend: load the wrapped DEK from
  // tenant_keys, unwrap with the KEK held in the Worker secret, log a
  // `kek_unwrap` audit row, and hand back an instance with the unwrapped DEK
  // held in memory for the request lifetime.
  //
  // Caller MUST hold workspace authorization (validated upstream by
  // requireSupabaseAuth + workspace membership). This function does NOT
  // re-check membership — it trusts the workspaceId.
  static async forWorkspace(
    workspaceId: string,
    opts?: { ip?: string; userAgent?: string },
  ): Promise<SupabaseEncryptedMirrorBackend> {
    const sb = supabaseService();
    const { data: keyRow, error: keyErr } = await sb
      .from("tenant_keys")
      .select("wrapped_dek")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (keyErr) {
      throw new Error(`tenant_keys lookup failed: ${keyErr.message}`);
    }
    if (!keyRow) {
      throw new NotFoundError(`tenant_keys for workspace ${workspaceId}`);
    }

    const wrapped = bytesFromPg(keyRow.wrapped_dek);
    const dek = unwrapDek(wrapped, workspaceId);

    // Audit insert is fire-and-forget at the call site: per security model,
    // audit failure must not block user requests. We log but don't throw.
    const { error: auditErr } = await sb.from("audit_log").insert({
      workspace_id: workspaceId,
      operation: "kek_unwrap",
      details: { reason: "backend_construct" },
      ip: opts?.ip ?? null,
      user_agent: opts?.userAgent ?? null,
    });
    if (auditErr) {
      console.error(
        `audit_log write failed for workspace ${workspaceId}: ${auditErr.message}`,
      );
    }

    return new SupabaseEncryptedMirrorBackend(sb, workspaceId, dek);
  }

  async readFile(filePath: string): Promise<string> {
    const normalized = filePath.trim();
    if (!normalized) throw new Error("filePath must not be empty");

    const { data: row, error: selectErr } = await this.supabase
      .from("vault_files")
      .select("storage_object")
      .eq("workspace_id", this.workspaceId)
      .eq("path", normalized)
      .is("deleted_at", null)
      .maybeSingle();
    if (selectErr) {
      throw new Error(`vault_files lookup failed: ${selectErr.message}`);
    }
    if (!row) {
      throw new NotFoundError(normalized);
    }

    const { data: blob, error: dlErr } = await this.supabase.storage
      .from(VAULT_BLOBS_BUCKET)
      .download(row.storage_object);
    if (dlErr || !blob) {
      // Metadata says the file exists but the blob is missing — treat as
      // not-found from the caller's perspective. (Could indicate a botched
      // delete, a missing Storage object, or a vault_files row that pre-dates
      // its blob upload. Either way the right answer for readers is NOT a
      // crypto error; surface it as not-found.)
      throw new NotFoundError(
        `storage object missing: ${row.storage_object} (${dlErr?.message ?? "no body"})`,
      );
    }

    const ciphertext = Buffer.from(await blob.arrayBuffer());
    return decryptBlob(ciphertext, this.dek, this.workspaceId).toString("utf8");
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const normalized = filePath.trim();
    if (!normalized) throw new Error("filePath must not be empty");

    const plaintext = Buffer.from(content, "utf8");
    const ciphertext = encryptBlob(plaintext, this.dek, this.workspaceId);
    const sha256 = createHash("sha256").update(plaintext).digest();
    const sha256Param = `\\x${sha256.toString("hex")}`;
    const nowIso = new Date().toISOString();

    // F5: drift detection writer. CLAUDE.md writes invalidate the
    // rules cache BEFORE we read it (so subsequent non-CLAUDE writes
    // see the new rules). Then compute the flags delta for THIS path
    // so the upsert below applies it in a single round trip.
    if (normalized === "CLAUDE.md") {
      invalidateRulesCache(this.workspaceId);
    }
    const rules = await getRulesForBackend(this, this.workspaceId);
    const flagsUpdate = computeFlagsUpdate(normalized, content, rules);

    // Pre-bake cardinality (with H1/body summary fallback) at write time so
    // loadIndexData can read it back in one SELECT instead of N readFiles.
    // extractCardinality is already try/catched internally (returns empty on
    // parse failure) — no additional guard needed at this call site.
    const enrichedCardinality = enrichCardinalitySummary(
      extractCardinality(content),
      content,
    );

    // Pass 3: pre-bake the per-file token index alongside cardinality (plaintext
    // is already in hand — zero extra reads). Passive under V1 (column ignored);
    // serves the V2 retrieval read once TAPROOT_RETRIEVAL_V2 is flipped.
    const extractedTokens = extractTokens(content);

    const legacy = legacyMissingBlobBehavior();

    // PR #2 (S99): determine the storage_object key BEFORE writing the
    // metadata row so we can upload the ciphertext first. SELECT lookup
    // up front: existing row → reuse its storage_object; new row →
    // mint a UUID-derived key (computable client-side, no DB round-trip
    // needed for derivation). Uploading first means a row can only ever
    // exist when its blob exists; the next pull on any device cannot
    // observe "row exists, blob missing" from a partial writeFile.
    const existing = await this.selectExistingForPath(normalized);
    const fileId = existing ? (existing.id as string) : randomUUID();
    const storageObject = existing
      ? (existing.storage_object as string)
      : `${this.workspaceId}/${fileId}`;

    const uploadBlob = async () => {
      // 0.1.7 Phase 2: wrap with withRetry. supabase-js Storage returns
      // errors via { error } rather than throwing, so the callback inspects
      // the returned error and re-throws — transient-tagged for 429/5xx (so
      // withRetry retries), or the user-facing error for non-transient (so
      // withRetry's isTransient check fails fast and re-throws unchanged).
      await withRetry(async () => {
        const { error: uploadErr } = await this.supabase.storage
          .from(VAULT_BLOBS_BUCKET)
          .upload(storageObject, ciphertext, {
            upsert: true,
            contentType: "application/octet-stream",
          });
        if (!uploadErr) return;
        const status = (uploadErr as { statusCode?: number | string })
          .statusCode;
        if (isTransientHttpStatus(status)) {
          throw Object.assign(new Error(uploadErr.message), { status });
        }
        throw new Error(
          `Storage upload failed for ${storageObject} (file_id=${fileId}): ${uploadErr.message}`,
        );
      });
    };

    if (!legacy) {
      // Blob first, then metadata. If upload throws, no row is committed.
      await uploadBlob();
    }

    await this.commitMetadataKnownKey({
      filePath: normalized,
      fileId,
      storageObject,
      existing,
      plaintextSize: plaintext.length,
      sha256Param,
      nowIso,
      flagsUpdate,
      extractedCardinality: enrichedCardinality,
      extractedTokens,
    });

    // V1.5a.1: Invalidate the index cache on any write except index.md itself
    // (writing index.md is the write-back path — triggering invalidation there
    // would create an infinite regeneration loop).
    if (normalized !== "index.md") {
      invalidateIndexForWorkspace(this.workspaceId, this);
    }

    if (legacy) {
      // Legacy order (metadata first, blob second). Preserved behind
      // MISSING_BLOB_LEGACY_BEHAVIOR=1 as a one-flip rollback gate.
      await uploadBlob();
    }
  }

  // PR #2 (S99) split: hoisted SELECT so writeFile can pre-compute
  // storageObject before the blob upload. Returns the existing alive row
  // (with id, storage_object, flags) or null. withRetry-wrapped to match
  // the prior upsertMetadata SELECT's transient-handling semantics.
  private async selectExistingForPath(filePath: string): Promise<{
    id: string;
    storage_object: string;
    flags?: Record<string, unknown>;
  } | null> {
    return await withRetry(async () => {
      const { data, error } = await this.supabase
        .from("vault_files")
        .select("id, storage_object, flags")
        .eq("workspace_id", this.workspaceId)
        .eq("path", filePath)
        .is("deleted_at", null)
        .maybeSingle();
      if (!error)
        return data as {
          id: string;
          storage_object: string;
          flags?: Record<string, unknown>;
        } | null;
      const status = (error as { status?: number | string }).status;
      if (isTransientHttpStatus(status)) {
        throw Object.assign(new Error(error.message), { status });
      }
      throw new Error(`vault_files lookup failed: ${error.message}`);
    });
  }

  // PR #2 (S99): commit the metadata row for a writeFile whose blob has
  // already been uploaded (in non-legacy mode) under a pre-known
  // storageObject. Performs UPDATE for an existing row, INSERT otherwise.
  // Race-lost INSERT (23505) re-resolves and UPDATEs through the racing
  // row's existing storage_object — the blob we already uploaded under
  // our minted fileId becomes orphan ciphertext (acceptable: low rate;
  // closes S99 by eliminating the metadata-before-blob window).
  private async commitMetadataKnownKey(args: {
    filePath: string;
    fileId: string;
    storageObject: string;
    existing: {
      id: string;
      storage_object: string;
      flags?: Record<string, unknown>;
    } | null;
    plaintextSize: number;
    sha256Param: string;
    nowIso: string;
    flagsUpdate: FlagsUpdate | null;
    extractedCardinality: Cardinality | null;
    extractedTokens: FileTokens | null;
  }): Promise<void> {
    const {
      filePath,
      fileId,
      storageObject,
      existing,
      plaintextSize,
      sha256Param,
      nowIso,
      flagsUpdate,
      extractedCardinality,
      extractedTokens,
    } = args;
    if (existing) {
      const newFlags = mergeFlags(
        (existing as { flags?: Record<string, unknown> }).flags ?? {},
        flagsUpdate,
      );
      const updateRow: Record<string, unknown> = {
        size_bytes: plaintextSize,
        plaintext_sha256: sha256Param,
        modified_at: nowIso,
        extracted_cardinality: extractedCardinality,
        extracted_tokens: extractedTokens,
      };
      if (newFlags) updateRow.flags = newFlags;
      await withRetry(async () => {
        const { error: updateErr } = await this.supabase
          .from("vault_files")
          .update(updateRow)
          .eq("id", existing.id);
        if (!updateErr) return;
        const status = (updateErr as { status?: number | string }).status;
        if (isTransientHttpStatus(status)) {
          throw Object.assign(new Error(updateErr.message), { status });
        }
        throw new Error(`vault_files UPDATE failed: ${updateErr.message}`);
      });
      return;
    }

    // PR #2: fileId + storageObject were minted by the caller (writeFile)
    // before the blob upload. We use them here directly so the INSERT
    // carries the same key the ciphertext was uploaded under.

    // F5: fresh INSERT starts with empty flags; apply delta (set only —
    // remove is a no-op against an empty object).
    const insertFlags = mergeFlags({}, flagsUpdate);

    const insertRow: Record<string, unknown> = {
      id: fileId,
      workspace_id: this.workspaceId,
      path: filePath,
      size_bytes: plaintextSize,
      plaintext_sha256: sha256Param,
      mime_type: "text/markdown",
      storage_object: storageObject,
      modified_at: nowIso,
      extracted_cardinality: extractedCardinality,
      extracted_tokens: extractedTokens,
    };
    if (insertFlags) insertRow.flags = insertFlags;

    // INSERT: wrapped in withRetry. PG_UNIQUE_VIOLATION (23505) is NOT
    // transient — it signals the race-resolve path below, so the callback
    // captures the PG code on the thrown Error and the outer try/catch
    // routes accordingly. supabase-js exposes the PG code at `error.code`.
    let insertCode: string | undefined;
    let insertMessage: string | undefined;
    let insertFailed = false;
    try {
      await withRetry(async () => {
        const { error } = await this.supabase
          .from("vault_files")
          .insert(insertRow);
        if (!error) return;
        const status = (error as { status?: number | string }).status;
        if (isTransientHttpStatus(status)) {
          throw Object.assign(new Error(error.message), { status });
        }
        throw Object.assign(new Error(error.message), {
          code: (error as { code?: string }).code,
        });
      });
    } catch (err) {
      insertFailed = true;
      insertCode = (err as { code?: string }).code;
      insertMessage = (err as Error).message;
    }

    if (insertFailed) {
      // Race lost: another writer inserted at the same path between our
      // SELECT and our INSERT. Re-resolve and UPDATE through the existing
      // row exactly once. A second 23505 surfaces.
      if (insertCode === PG_UNIQUE_VIOLATION) {
        const race = await withRetry(async () => {
          const { data, error: raceErr } = await this.supabase
            .from("vault_files")
            .select("id, storage_object, flags")
            .eq("workspace_id", this.workspaceId)
            .eq("path", filePath)
            .is("deleted_at", null)
            .single();
          if (!raceErr && data) return data;
          const status = (raceErr as { status?: number | string } | null)
            ?.status;
          if (isTransientHttpStatus(status)) {
            throw Object.assign(new Error(raceErr?.message ?? "row vanished"), {
              status,
            });
          }
          throw new Error(
            `vault_files race resolve failed: ${raceErr?.message ?? "row vanished"}`,
          );
        });
        const raceFlags = mergeFlags(
          (race as { flags?: Record<string, unknown> }).flags ?? {},
          flagsUpdate,
        );
        const raceUpdateRow: Record<string, unknown> = {
          size_bytes: plaintextSize,
          plaintext_sha256: sha256Param,
          modified_at: nowIso,
          extracted_cardinality: extractedCardinality,
          extracted_tokens: extractedTokens,
        };
        if (raceFlags) raceUpdateRow.flags = raceFlags;
        await withRetry(async () => {
          const { error: updateErr } = await this.supabase
            .from("vault_files")
            .update(raceUpdateRow)
            .eq("id", race.id);
          if (!updateErr) return;
          const status = (updateErr as { status?: number | string }).status;
          if (isTransientHttpStatus(status)) {
            throw Object.assign(new Error(updateErr.message), { status });
          }
          throw new Error(
            `vault_files UPDATE after race failed: ${updateErr.message}`,
          );
        });
        // PR #2: the blob we uploaded under our minted fileId is now
        // orphan ciphertext (the winning row points at its OWN
        // storage_object). Acceptable: race rate is low and a future GC
        // pass can sweep vault-blobs against vault_files.storage_object.
        return;
      }
      throw new Error(`vault_files INSERT failed: ${insertMessage}`);
    }
  }

  async listFiles(subPath?: string, recursive = true): Promise<string[]> {
    let query = this.supabase
      .from("vault_files")
      .select("path")
      .eq("workspace_id", this.workspaceId)
      .is("deleted_at", null);

    const trimmedSub = subPath?.trim();
    const prefix = trimmedSub
      ? trimmedSub.endsWith("/")
        ? trimmedSub
        : `${trimmedSub}/`
      : null;

    if (prefix) {
      // H8 (04-30): escape Postgres LIKE metacharacters so a path component
      // containing `%` or `_` (or the escape char `\`) does not over-match.
      const escapedPrefix = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
      query = query.like("path", `${escapedPrefix}%`);
    }

    const { data, error } = await query.limit(1000);
    if (error) throw new Error(`listFiles failed: ${error.message}`);
    let paths = (data ?? []).map((r) => r.path as string);

    if (!recursive) {
      if (prefix) {
        // Direct children of subPath: no further `/` after the prefix
        paths = paths.filter((p) => !p.slice(prefix.length).includes("/"));
      } else {
        // Top-level only: no `/` at all
        paths = paths.filter((p) => !p.includes("/"));
      }
    }

    return paths;
  }

  // Lightweight metadata fetch for index builds. Returns (path, cardinality)
  // for every alive file in one PostgREST round-trip — replaces the per-file
  // readFile fanout (~1,600 ops for an 800-file vault) that dominated
  // loadIndexData. Files written before the extracted_cardinality column
  // existed return null and fall back to the legacy read path in
  // loadIndexData (which then batch-writes the result back via
  // batchUpdateCardinalities — one-time backfill).
  //
  // 1000-row cap matches listFiles() and TOTAL_FILE_LIMIT in index-tool;
  // loadIndexData already renders a "Showing first 1000 files" notice when
  // saturated. Pagination is out of scope for this change.
  async listFilesMeta(subPath?: string): Promise<FileMeta[]> {
    let query = this.supabase
      .from("vault_files")
      .select("path, extracted_cardinality, extracted_tokens")
      .eq("workspace_id", this.workspaceId)
      .is("deleted_at", null);

    const trimmedSub = subPath?.trim();
    const prefix = trimmedSub
      ? trimmedSub.endsWith("/")
        ? trimmedSub
        : `${trimmedSub}/`
      : null;
    if (prefix) {
      // Match listFiles H8 escaping: % _ \ must be escaped for LIKE.
      const escapedPrefix = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
      query = query.like("path", `${escapedPrefix}%`);
    }

    const { data, error } = await query.limit(1000);
    if (error) throw new Error(`listFilesMeta failed: ${error.message}`);
    return (data ?? []).map((r) => ({
      path: r.path as string,
      cardinality: (r.extracted_cardinality as Cardinality | null) ?? null,
      tokens: (r.extracted_tokens as FileTokens | null) ?? null,
    }));
  }

  // Pass 3 (Path B): UNCAPPED per-file token reader for the V2 retrieval index.
  // listFilesMeta caps at 1000 (index.md's map wants that); retrieval cannot, or
  // notes past the 1000th go dark on big vaults. Paginated with .range() over a
  // stable .order("path") so every row is returned exactly once. Selects only
  // path + extracted_tokens (no cardinality) — the smallest payload that still
  // covers the whole vault in a handful of round trips (tokens are bounded by
  // BODY_TOKEN_CAP). No blob downloads — this is a plaintext column read, NOT
  // the encrypted-body scan that caused the original hang.
  async listFileTokensMeta(subPath?: string): Promise<FileMeta[]> {
    const PAGE = 1000;
    const trimmedSub = subPath?.trim();
    const prefix = trimmedSub
      ? trimmedSub.endsWith("/")
        ? trimmedSub
        : `${trimmedSub}/`
      : null;
    const escapedPrefix = prefix
      ? prefix.replace(/[\\%_]/g, (c) => `\\${c}`)
      : null;

    const out: FileMeta[] = [];
    for (let from = 0; ; from += PAGE) {
      let query = this.supabase
        .from("vault_files")
        .select("path, extracted_tokens")
        .eq("workspace_id", this.workspaceId)
        .is("deleted_at", null)
        .order("path", { ascending: true })
        .range(from, from + PAGE - 1);
      if (escapedPrefix) query = query.like("path", `${escapedPrefix}%`);

      const { data, error } = await query;
      if (error) throw new Error(`listFileTokensMeta failed: ${error.message}`);
      const rows = data ?? [];
      for (const r of rows) {
        out.push({
          path: r.path as string,
          cardinality: null,
          tokens: (r.extracted_tokens as FileTokens | null) ?? null,
        });
      }
      if (rows.length < PAGE) break;
    }
    return out;
  }

  // Fire-and-forget backfill writes from loadIndexData when it encounters
  // files with null extracted_cardinality. Chunked Promise.all with
  // concurrency=10 (same pattern as 0.1.7 sync push parallelism).
  //
  // The .is('extracted_cardinality', null) race-guard is mandatory:
  // writeFile triggers a debounced 500ms flush, and a user could save the
  // same file twice while a backfill is in flight. Without the guard, the
  // backfill's UPDATE would clobber a fresh writeFile value with the stale
  // one it read earlier. With the guard, backfill is a strict null-fill
  // and never overwrites a populated row.
  async batchUpdateCardinalities(
    updates: Map<string, Cardinality>,
  ): Promise<void> {
    if (updates.size === 0) return;
    const concurrency = 10;
    const entries = [...updates.entries()];
    for (let i = 0; i < entries.length; i += concurrency) {
      const chunk = entries.slice(i, i + concurrency);
      await Promise.all(
        chunk.map(([filePath, cardinality]) =>
          this.supabase
            .from("vault_files")
            .update({ extracted_cardinality: cardinality })
            .eq("workspace_id", this.workspaceId)
            .eq("path", filePath)
            .is("deleted_at", null)
            .is("extracted_cardinality", null),
        ),
      );
    }
  }

  // Pass 3 token backfill — same chunked, fire-and-forget shape as
  // batchUpdateCardinalities. The .is("extracted_tokens", null) race-guard is
  // mandatory for the same reason: a debounced flush could race a fresh
  // writeFile (which writes tokens directly); the guard makes backfill a strict
  // null-fill that never clobbers a populated row.
  async batchUpdateTokens(updates: Map<string, FileTokens>): Promise<void> {
    if (updates.size === 0) return;
    const concurrency = 10;
    const entries = [...updates.entries()];
    for (let i = 0; i < entries.length; i += concurrency) {
      const chunk = entries.slice(i, i + concurrency);
      await Promise.all(
        chunk.map(([filePath, tokens]) =>
          this.supabase
            .from("vault_files")
            .update({ extracted_tokens: tokens })
            .eq("workspace_id", this.workspaceId)
            .eq("path", filePath)
            .is("deleted_at", null)
            .is("extracted_tokens", null),
        ),
      );
    }
  }

  async exists(filePath: string): Promise<boolean> {
    const normalized = filePath.trim();
    // Match LocalBackend semantics: empty / whitespace path is "doesn't exist",
    // not an error.
    if (!normalized) return false;

    const { count, error } = await this.supabase
      .from("vault_files")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", this.workspaceId)
      .eq("path", normalized)
      .is("deleted_at", null);
    if (error) throw new Error(`exists failed: ${error.message}`);
    return (count ?? 0) > 0;
  }

  async mkdir(_dirPath: string): Promise<void> {
    // Deliberate no-op: vault_files only stores leaf .md files; empty
    // directories are not represented in the cloud mirror. A "directory"
    // exists implicitly the moment a file is written under a non-existent
    // prefix. If a user creates an empty folder in Obsidian and expects it
    // to round-trip, it won't. Documented limitation.
  }

  async delete(filePath: string): Promise<void> {
    const normalized = filePath.trim();
    if (!normalized) throw new Error("filePath must not be empty");

    // T11.4 IQ-1: bump modified_at alongside deleted_at so soft-deletes
    // advance the (modified_at, id) cursor used by GET /api/sync/pull.
    // Without this, the cursor query silently misses tombstones.
    const nowIso = new Date().toISOString();
    const { count, error } = await this.supabase
      .from("vault_files")
      .update({ deleted_at: nowIso, modified_at: nowIso }, { count: "exact" })
      .eq("workspace_id", this.workspaceId)
      .eq("path", normalized)
      .is("deleted_at", null);
    if (error) throw new Error(`delete failed: ${error.message}`);
    if ((count ?? 0) === 0) throw new NotFoundError(normalized);

    // Storage blob is intentionally NOT removed on soft delete. T4.6's
    // nuke flow is what reclaims storage; this leaves a paper trail and
    // makes "restore from trash" straightforward in a future Stage 2 UX.
  }

  async move(oldPath: string, newPath: string): Promise<void> {
    const oldNorm = oldPath.trim();
    const newNorm = newPath.trim();
    if (!oldNorm || !newNorm) throw new Error("paths must not be empty");
    if (oldNorm === newNorm) return;

    // Storage object key is `{workspace_id}/{vault_files.id}` — keyed by
    // file_id, never by path. So move() is a single SQL UPDATE on the
    // path column; the blob bytes don't move.
    const { count, error } = await this.supabase
      .from("vault_files")
      .update(
        { path: newNorm, modified_at: new Date().toISOString() },
        { count: "exact" },
      )
      .eq("workspace_id", this.workspaceId)
      .eq("path", oldNorm)
      .is("deleted_at", null);

    if (error) {
      const code = (error as { code?: string }).code;
      if (code === PG_UNIQUE_VIOLATION) {
        throw new ConflictError(`move target already exists: ${newNorm}`);
      }
      throw new Error(`move failed: ${error.message}`);
    }
    if ((count ?? 0) === 0) throw new NotFoundError(oldNorm);
  }

  async stat(filePath: string): Promise<FileStat> {
    const normalized = filePath.trim();
    if (!normalized) throw new Error("filePath must not be empty");

    const { data, error } = await this.supabase
      .from("vault_files")
      .select("size_bytes, modified_at")
      .eq("workspace_id", this.workspaceId)
      .eq("path", normalized)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) throw new Error(`stat failed: ${error.message}`);
    if (!data) throw new NotFoundError(normalized);

    return {
      size: data.size_bytes as number,
      modifiedAt: new Date(data.modified_at as string),
    };
  }

  async recentFiles(n: number): Promise<string[]> {
    const limit = Math.max(0, Math.floor(n));
    if (limit === 0) return [];

    const { data, error } = await this.supabase
      .from("vault_files")
      .select("path")
      .eq("workspace_id", this.workspaceId)
      .is("deleted_at", null)
      .order("modified_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`recentFiles failed: ${error.message}`);
    return (data ?? []).map((r) => r.path as string);
  }

  // T11.4 — pull cursor query. Returns rows since the (modifiedAt, id) tuple
  // cursor in (modified_at, id) ASC order. Initial pull (cursor=null) returns
  // alive rows only; cursor pulls return all rows including soft-deleted
  // tombstones (per IQ-1, soft-delete bumps modified_at so deletes advance
  // the cursor). Inline `content` decrypted for non-deleted rows (D1.a) so
  // the helper has no decrypt path of its own.
  async listChanged(
    cursor: PullCursor | null,
    limit: number,
  ): Promise<ListChangedResult> {
    // Cursor goes back to the helper, which round-trips it as a `since` query
    // param. Express's query parser decodes `+` as a space (form-encoded
    // semantics), so a Postgres timestamptz like `2026-...+00:00` would
    // arrive as `2026-... 00:00` and Zod's datetime() validator would 400.
    // Normalize the trailing `+00:00` to `Z` (RFC 3339 short form). The
    // prefix is preserved exactly so we don't drop sub-millisecond precision.
    const normalizeIso = (t: string): string =>
      t.endsWith("+00:00") ? t.slice(0, -6) + "Z" : t;

    let query = this.supabase
      .from("vault_files")
      .select("id, path, size_bytes, modified_at, deleted_at, storage_object")
      .eq("workspace_id", this.workspaceId)
      .order("modified_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(limit);

    if (cursor) {
      // Tuple inequality: (modified_at > since) OR (modified_at = since AND id > since_id)
      query = query.or(
        `modified_at.gt.${cursor.modifiedAt},and(modified_at.eq.${cursor.modifiedAt},id.gt.${cursor.id})`,
      );
    } else {
      // Initial pull — only alive files. Helper has no local tombstones to
      // reconcile; sending soft-deleted rows would be noise.
      query = query.is("deleted_at", null);
    }

    const { data: rows, error } = await query;
    if (error) throw new Error(`listChanged query failed: ${error.message}`);

    // Per row: fetch + decrypt content for alive rows. Runs concurrently in
    // chunks of PULL_PARALLELISM (default 10, env-var rollback gate).
    const parallelismRaw = parseInt(process.env.PULL_PARALLELISM ?? "10", 10);
    const concurrency = Math.max(
      1,
      isNaN(parallelismRaw) ? 10 : parallelismRaw,
    );

    // PR #2 classification: processRow returns one of
    //   { kind: "success", change }   genuine content (or tombstone) — cursor may advance
    //   { kind: "pending", change }   missing-blob inside grace window — emit + halt cursor
    //   { kind: "skip" }              transient error — omit + halt cursor
    type RowOutcome =
      | { kind: "success"; change: VaultFileChange }
      | { kind: "pending"; change: VaultFileChange }
      | { kind: "skip" };

    const legacy = legacyMissingBlobBehavior();
    const graceMs = missingBlobGraceMs();
    type RowType = NonNullable<typeof rows>[0];
    const processRow = async (row: RowType): Promise<RowOutcome> => {
      const baseFields = {
        path: row.path as string,
        size: row.size_bytes as number,
        modifiedAt: normalizeIso(row.modified_at as string),
        id: row.id as string,
        deleted: row.deleted_at !== null,
      };
      if (baseFields.deleted) return { kind: "success", change: baseFields };

      let blob: Blob;
      try {
        // withRetry handles transient 5xx + timeout (statusCode 504 makes the
        // timeout detectable by isTransient, so it retries up to 3x then skips).
        blob = await withRetry(async () => {
          const { data, error: dlErr } = await Promise.race([
            this.supabase.storage
              .from(VAULT_BLOBS_BUCKET)
              .download(row.storage_object as string),
            new Promise<{
              data: null;
              error: { message: string; statusCode?: string };
            }>((resolve) =>
              setTimeout(
                () =>
                  resolve({
                    data: null,
                    error: {
                      message: "blob download timeout after 10s",
                      statusCode: "504",
                    },
                  }),
                10_000,
              ),
            ),
          ]);
          if (dlErr || !data) {
            throw Object.assign(
              new Error(dlErr?.message ?? "download failed"),
              {
                statusCode: dlErr?.statusCode,
              },
            );
          }
          return data;
        });
      } catch (err) {
        // Post-retry classifier: distinguish transient (skip, halt cursor)
        // from missing blob (within grace = pending, else tombstone).
        const e = err as { statusCode?: unknown; message?: string };
        const statusCode = String(e.statusCode ?? "");
        const msg = (e.message ?? "").toLowerCase();
        const isTransientErr =
          ["500", "502", "503", "504"].includes(statusCode) ||
          msg.includes("timeout") ||
          msg.includes("gateway");
        if (isTransientErr) {
          console.error(
            `[listChanged] transient storage error for ${row.path}, skipping (cursor halts): ${e.message ?? "no body"}`,
          );
          return { kind: "skip" };
        }
        // Genuine missing blob (404). In legacy mode, preserve the binary
        // mapping. Otherwise, classify by modified_at recency.
        if (legacy) {
          console.error(
            `[listChanged] storage object missing for ${row.path} (legacy): ${e.message ?? "no body"}`,
          );
          return {
            kind: "success",
            change: { ...baseFields, deleted: true },
          };
        }
        const modifiedAtMs = Date.parse(baseFields.modifiedAt);
        const ageMs = isNaN(modifiedAtMs)
          ? Infinity
          : Date.now() - modifiedAtMs;
        if (ageMs < graceMs) {
          console.error(
            `[listChanged] storage object missing for ${row.path} but row is ${ageMs}ms old (<${graceMs}ms grace); marking pending: ${e.message ?? "no body"}`,
          );
          return {
            kind: "pending",
            change: { ...baseFields, pending: true },
          };
        }
        console.error(
          `[listChanged] storage object missing for ${row.path}; row is ${ageMs}ms old (>=${graceMs}ms grace); marking deleted: ${e.message ?? "no body"}`,
        );
        return {
          kind: "success",
          change: { ...baseFields, deleted: true },
        };
      }

      const ciphertext = Buffer.from(await blob.arrayBuffer());
      const plaintext = decryptBlob(
        ciphertext,
        this.dek,
        this.workspaceId,
      ).toString("utf8");
      return { kind: "success", change: { ...baseFields, content: plaintext } };
    };

    // PR #2 cursor accounting: per-row `processed` boolean (true only for
    // genuine successes). After processing all chunks, scan forward from
    // index 0 to find the last contiguous success — that becomes the
    // cursor. First non-success halts the advance, regardless of any later
    // successes in the page (preserves in-order pull semantics).
    const rowsArr = rows ?? [];
    const files: VaultFileChange[] = [];
    const processed: boolean[] = new Array(rowsArr.length).fill(false);
    for (let i = 0; i < rowsArr.length; i += concurrency) {
      const chunk = rowsArr.slice(i, i + concurrency);
      const chunkResults = await Promise.all(
        chunk.map((row) => processRow(row)),
      );
      for (let j = 0; j < chunkResults.length; j++) {
        const r = chunkResults[j];
        if (r.kind === "skip") continue;
        files.push(r.change);
        if (r.kind === "success") processed[i + j] = true;
        // pending: emitted to the helper for visibility but does NOT mark
        // the row as processed — the cursor halts here so the next pull
        // re-offers the row.
      }
    }

    // PR #2: cursor advances to the LAST contiguously-processed row.
    // Legacy mode (kill switch) preserves the historical "advance to
    // rows[length-1] regardless of skip" behavior.
    let next: PullCursor | null = cursor;
    if (legacy) {
      if (rowsArr.length > 0) {
        const last = rowsArr[rowsArr.length - 1];
        next = {
          modifiedAt: normalizeIso(last.modified_at as string),
          id: last.id as string,
        };
      }
    } else {
      let lastSuccessIdx = -1;
      for (let i = 0; i < rowsArr.length; i++) {
        if (processed[i]) lastSuccessIdx = i;
        else break; // first non-success halts cursor advance
      }
      if (lastSuccessIdx >= 0) {
        const last = rowsArr[lastSuccessIdx];
        next = {
          modifiedAt: normalizeIso(last.modified_at as string),
          id: last.id as string,
        };
      }
    }

    // S2: count rows remaining after this page so the helper can show
    // "X files behind" in the menu bar. Uses the same tuple-cursor ordering
    // as the main query; covered by the same index. Zero when page is empty
    // (cursor at head) or when this is the last/only page.
    let pendingCount = 0;
    if (rows && rows.length > 0 && next) {
      let countQuery = this.supabase
        .from("vault_files")
        .select("*", { count: "exact", head: true })
        .eq("workspace_id", this.workspaceId)
        .or(
          `modified_at.gt.${next.modifiedAt},and(modified_at.eq.${next.modifiedAt},id.gt.${next.id})`,
        );
      if (!cursor) {
        // Initial pull only fetched alive files — count only alive rows too.
        countQuery = countQuery.is("deleted_at", null);
      }
      const { count } = await countQuery;
      pendingCount = count ?? 0;
    }

    return { files, next, pendingCount };
  }

  // Blocker 1 — between-tick "X files behind" visibility. Returns the count of
  // alive vault_files rows after the helper's keyset cursor, using the same
  // tuple-cursor predicate as listChanged but with `head: true` so PostgREST
  // returns just the count (no row data — no blob fetch). Backed by the same
  // (workspace_id, modified_at, id) index as the pull query. Helper calls this
  // at the start of each pullTick BEFORE the .syncing flip, so the menu can
  // show "3 files behind · Synced HH:MM" during the 30s idle window between
  // ticks (today the menu always shows "Synced" between ticks even when AI
  // writes are queued).
  async getPendingCount(cursor: PullCursor | null): Promise<number> {
    if (!cursor) return 0;
    const normalizeIso = (t: string): string =>
      t.endsWith("+00:00") ? t.slice(0, -6) + "Z" : t;
    const since = normalizeIso(cursor.modifiedAt);
    // Match listChanged's cursor-present semantics: when a cursor is provided
    // the pull includes deleted rows (helper applies tombstones), so the
    // count must include them too. The cursor==null branch above short-
    // circuits to 0, so we never need the alive-only filter here.
    const { count, error } = await this.supabase
      .from("vault_files")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", this.workspaceId)
      .or(
        `modified_at.gt.${since},and(modified_at.eq.${since},id.gt.${cursor.id})`,
      );
    if (error) throw new Error(`getPendingCount failed: ${error.message}`);
    return count ?? 0;
  }

  async getCursorHead(): Promise<{ modifiedAt: string; id: string } | null> {
    const normalizeIsoToZ = (t: string): string =>
      t.endsWith("+00:00") ? t.slice(0, -6) + "Z" : t;
    const { data, error } = await this.supabase
      .from("vault_files")
      .select("modified_at, id")
      .eq("workspace_id", this.workspaceId)
      .is("deleted_at", null)
      .order("modified_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`getCursorHead failed: ${error.message}`);
    if (!data) return null;
    return {
      modifiedAt: normalizeIsoToZ(data.modified_at as string),
      id: data.id as string,
    };
  }
}

// Supabase Storage `remove([])` accepts up to 1000 paths per call.
const STORAGE_REMOVE_BATCH = 1000;

export interface NukeResult {
  objectCount: number;
  fileRowCount: number;
}

// "Leave Taproot" — hard-delete the cloud mirror end-to-end. Per the locked
// T4 decision: the mirror dies (Storage blobs + vault_files rows + tenant_keys
// row), but the workspace + workspace_members + auth.users rows survive so the
// user can re-onboard or invite teammates without going through full account
// recreation. Full account delete is a separate Stage 2+ button.
//
// Audit row (`operation = 'vault_nuke'`) is fire-and-forget, same posture as
// `kek_unwrap`: if the audit insert fails, the deletion already happened — log
// the failure but don't roll back. Rolling back a half-completed nuke is
// worse than a missing audit row.
//
// This function is idempotent: calling it on a workspace whose mirror is
// already gone is a no-op (returns counts of 0).
export async function nukeWorkspace(
  supabase: SupabaseClient,
  workspaceId: string,
  actorUserId: string | null,
  opts?: { ip?: string; userAgent?: string },
): Promise<NukeResult> {
  const { data: rows, error: listErr } = await supabase
    .from("vault_files")
    .select("storage_object")
    .eq("workspace_id", workspaceId);
  if (listErr) {
    throw new Error(`nuke: vault_files list failed: ${listErr.message}`);
  }
  const storageObjects = (rows ?? []).map((r) => r.storage_object as string);

  const legacy = legacyMissingBlobBehavior();

  // PR #2 (S97): delete vault_files rows BEFORE removing Storage blobs.
  // Closing the window where a concurrent helper pull sees "row exists,
  // blob missing" → maps to deleted: true → helper destroys the user's
  // local plaintext during "Leave Taproot". With rows gone first, the
  // pull returns an empty page for those paths and no delete is emitted.
  // The few seconds of orphan blobs are operationally fine — they're
  // encrypted with the DEK that's about to die when tenant_keys is
  // deleted. Legacy ordering preserved behind MISSING_BLOB_LEGACY_BEHAVIOR.
  let deletedFileCount: number | null = null;
  if (legacy) {
    for (let i = 0; i < storageObjects.length; i += STORAGE_REMOVE_BATCH) {
      const chunk = storageObjects.slice(i, i + STORAGE_REMOVE_BATCH);
      const { error: rmErr } = await supabase.storage
        .from(VAULT_BLOBS_BUCKET)
        .remove(chunk);
      if (rmErr) {
        throw new Error(
          `nuke: Storage remove batch (${i}-${i + chunk.length}) failed (legacy): ${rmErr.message}`,
        );
      }
    }
    const { count, error: filesDelErr } = await supabase
      .from("vault_files")
      .delete({ count: "exact" })
      .eq("workspace_id", workspaceId);
    if (filesDelErr) {
      throw new Error(
        `nuke: vault_files delete failed (legacy): ${filesDelErr.message}`,
      );
    }
    deletedFileCount = count ?? 0;
  } else {
    const { count, error: filesDelErr } = await supabase
      .from("vault_files")
      .delete({ count: "exact" })
      .eq("workspace_id", workspaceId);
    if (filesDelErr) {
      throw new Error(
        `nuke: vault_files delete failed: ${filesDelErr.message}`,
      );
    }
    deletedFileCount = count ?? 0;

    for (let i = 0; i < storageObjects.length; i += STORAGE_REMOVE_BATCH) {
      const chunk = storageObjects.slice(i, i + STORAGE_REMOVE_BATCH);
      const { error: rmErr } = await supabase.storage
        .from(VAULT_BLOBS_BUCKET)
        .remove(chunk);
      if (rmErr) {
        // Rows are already gone — Storage failures here leave orphan
        // ciphertext blobs (encrypted with the DEK we're about to drop).
        // Better to surface the partial failure than to roll back deleted
        // rows. Caller's audit_log still records the nuke attempt.
        throw new Error(
          `nuke: Storage remove batch (${i}-${i + chunk.length}) failed AFTER vault_files delete (rows gone, blobs orphaned): ${rmErr.message}`,
        );
      }
    }
  }

  const { error: keysDelErr } = await supabase
    .from("tenant_keys")
    .delete()
    .eq("workspace_id", workspaceId);
  if (keysDelErr) {
    throw new Error(`nuke: tenant_keys delete failed: ${keysDelErr.message}`);
  }

  const { error: auditErr } = await supabase.from("audit_log").insert({
    workspace_id: workspaceId,
    user_id: actorUserId,
    operation: "vault_nuke",
    details: { object_count: storageObjects.length },
    ip: opts?.ip ?? null,
    user_agent: opts?.userAgent ?? null,
  });
  if (auditErr) {
    console.error(
      `audit_log write failed for vault_nuke ${workspaceId}: ${auditErr.message}`,
    );
  }

  return {
    objectCount: storageObjects.length,
    fileRowCount: deletedFileCount ?? 0,
  };
}
