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
  FileStat,
  ListChangedResult,
  PullCursor,
  StorageBackend,
  VaultFileChange,
} from "./storage.js";
import { ConflictError, NotFoundError } from "./storage.js";
import { supabaseService } from "../api/supabase.js";
import { decryptBlob, encryptBlob, unwrapDek } from "../api/crypto.js";
import {
  computeFlagsUpdate,
  getRulesForBackend,
  invalidateRulesCache,
  mergeFlags,
  type FlagsUpdate,
} from "./drift.js";

const VAULT_BLOBS_BUCKET = "vault-blobs";
const PG_UNIQUE_VIOLATION = "23505";

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
    const flagsUpdate = computeFlagsUpdate(normalized, rules);

    const { fileId, storageObject } = await this.upsertMetadata(
      normalized,
      plaintext.length,
      sha256Param,
      nowIso,
      flagsUpdate,
    );

    const { error: uploadErr } = await this.supabase.storage
      .from(VAULT_BLOBS_BUCKET)
      .upload(storageObject, ciphertext, {
        upsert: true,
        contentType: "application/octet-stream",
      });
    if (uploadErr) {
      throw new Error(
        `Storage upload failed for ${storageObject} (file_id=${fileId}): ${uploadErr.message}`,
      );
    }
  }

  // SELECT → UPDATE-or-INSERT for vault_files. Returns the file_id so the
  // caller knows which storage_object key to upload the blob under. The
  // partial unique index on (workspace_id, path) WHERE deleted_at IS NULL
  // protects against concurrent writers — if two writers both miss the
  // SELECT and both INSERT, one wins and the other gets PG 23505; the
  // loser re-resolves via SELECT and falls through to UPDATE.
  private async upsertMetadata(
    filePath: string,
    plaintextSize: number,
    sha256Param: string,
    nowIso: string,
    flagsUpdate: FlagsUpdate | null = null,
  ): Promise<{ fileId: string; storageObject: string }> {
    const { data: existing, error: selectErr } = await this.supabase
      .from("vault_files")
      .select("id, storage_object, flags")
      .eq("workspace_id", this.workspaceId)
      .eq("path", filePath)
      .is("deleted_at", null)
      .maybeSingle();
    if (selectErr) {
      throw new Error(`vault_files lookup failed: ${selectErr.message}`);
    }

    if (existing) {
      const newFlags = mergeFlags(
        (existing as { flags?: Record<string, unknown> }).flags ?? {},
        flagsUpdate,
      );
      const updateRow: Record<string, unknown> = {
        size_bytes: plaintextSize,
        plaintext_sha256: sha256Param,
        modified_at: nowIso,
      };
      if (newFlags) updateRow.flags = newFlags;
      const { error: updateErr } = await this.supabase
        .from("vault_files")
        .update(updateRow)
        .eq("id", existing.id);
      if (updateErr) {
        throw new Error(`vault_files UPDATE failed: ${updateErr.message}`);
      }
      return { fileId: existing.id, storageObject: existing.storage_object };
    }

    // Mint id client-side so storage_object (NOT NULL) can be set in the
    // same INSERT — saves a follow-up UPDATE round-trip per new file.
    const fileId = randomUUID();
    const storageObject = `${this.workspaceId}/${fileId}`;

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
    };
    if (insertFlags) insertRow.flags = insertFlags;

    const { error: insertErr } = await this.supabase
      .from("vault_files")
      .insert(insertRow);

    if (insertErr) {
      // Race lost: another writer inserted at the same path between our
      // SELECT and our INSERT. Re-resolve and UPDATE through the existing
      // row exactly once. A second 23505 surfaces.
      const code = (insertErr as { code?: string }).code;
      if (code === PG_UNIQUE_VIOLATION) {
        const { data: race, error: raceErr } = await this.supabase
          .from("vault_files")
          .select("id, storage_object, flags")
          .eq("workspace_id", this.workspaceId)
          .eq("path", filePath)
          .is("deleted_at", null)
          .single();
        if (raceErr || !race) {
          throw new Error(
            `vault_files race resolve failed: ${raceErr?.message ?? "row vanished"}`,
          );
        }
        const raceFlags = mergeFlags(
          (race as { flags?: Record<string, unknown> }).flags ?? {},
          flagsUpdate,
        );
        const raceUpdateRow: Record<string, unknown> = {
          size_bytes: plaintextSize,
          plaintext_sha256: sha256Param,
          modified_at: nowIso,
        };
        if (raceFlags) raceUpdateRow.flags = raceFlags;
        const { error: updateErr } = await this.supabase
          .from("vault_files")
          .update(raceUpdateRow)
          .eq("id", race.id);
        if (updateErr) {
          throw new Error(
            `vault_files UPDATE after race failed: ${updateErr.message}`,
          );
        }
        return { fileId: race.id, storageObject: race.storage_object };
      }
      throw new Error(`vault_files INSERT failed: ${insertErr.message}`);
    }

    return { fileId, storageObject };
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

    // Per row: if alive, fetch + decrypt content via the same path readFile
    // uses. Reuses the in-memory DEK held by this backend instance.
    const files: VaultFileChange[] = [];
    for (const row of rows ?? []) {
      const baseFields = {
        path: row.path as string,
        size: row.size_bytes as number,
        modifiedAt: normalizeIso(row.modified_at as string),
        id: row.id as string,
        deleted: row.deleted_at !== null,
      };
      if (baseFields.deleted) {
        files.push(baseFields);
        continue;
      }
      const { data: blob, error: dlErr } = await this.supabase.storage
        .from(VAULT_BLOBS_BUCKET)
        .download(row.storage_object as string);
      if (dlErr || !blob) {
        // Metadata says alive but blob missing — same posture as readFile:
        // surface as deleted to the helper so it removes any stale local copy.
        console.error(
          `[listChanged] storage object missing for ${row.path}: ${dlErr?.message ?? "no body"}`,
        );
        files.push({ ...baseFields, deleted: true });
        continue;
      }
      const ciphertext = Buffer.from(await blob.arrayBuffer());
      const plaintext = decryptBlob(
        ciphertext,
        this.dek,
        this.workspaceId,
      ).toString("utf8");
      files.push({ ...baseFields, content: plaintext });
    }

    // Cursor: last row of returned page. Empty page echoes input cursor
    // (so a polling helper that's caught up keeps re-asking with the same
    // since/since_id and the server keeps returning empty).
    let next: PullCursor | null = cursor;
    if (rows && rows.length > 0) {
      const last = rows[rows.length - 1];
      next = {
        modifiedAt: normalizeIso(last.modified_at as string),
        id: last.id as string,
      };
    }

    return { files, next };
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

  for (let i = 0; i < storageObjects.length; i += STORAGE_REMOVE_BATCH) {
    const chunk = storageObjects.slice(i, i + STORAGE_REMOVE_BATCH);
    const { error: rmErr } = await supabase.storage
      .from(VAULT_BLOBS_BUCKET)
      .remove(chunk);
    if (rmErr) {
      throw new Error(
        `nuke: Storage remove batch (${i}-${i + chunk.length}) failed: ${rmErr.message}`,
      );
    }
  }

  const { count: deletedFileCount, error: filesDelErr } = await supabase
    .from("vault_files")
    .delete({ count: "exact" })
    .eq("workspace_id", workspaceId);
  if (filesDelErr) {
    throw new Error(`nuke: vault_files delete failed: ${filesDelErr.message}`);
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
