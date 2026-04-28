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
import type { StorageBackend, FileStat } from "./storage.js";
import { NotFoundError } from "./storage.js";
import { supabaseService } from "../api/supabase.js";
import { encryptBlob, unwrapDek } from "../api/crypto.js";

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
    private workspaceId: string,
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
    const dek = unwrapDek(wrapped);

    // Audit insert is fire-and-forget at the call site: per security model,
    // audit failure must not block user requests. We log but don't throw.
    const { error: auditErr } = await sb.from("audit_log").insert({
      workspace_id: workspaceId,
      operation: "kek_unwrap",
      details: { reason: "backend_construct" },
    });
    if (auditErr) {
      console.error(
        `audit_log write failed for workspace ${workspaceId}: ${auditErr.message}`,
      );
    }

    return new SupabaseEncryptedMirrorBackend(sb, workspaceId, dek);
  }

  async readFile(_filePath: string): Promise<string> {
    throw new Error("NotImplemented: T4.3");
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const normalized = filePath.trim();
    if (!normalized) throw new Error("filePath must not be empty");

    const plaintext = Buffer.from(content, "utf8");
    const ciphertext = encryptBlob(plaintext, this.dek);
    const sha256 = createHash("sha256").update(plaintext).digest();
    const sha256Param = `\\x${sha256.toString("hex")}`;
    const nowIso = new Date().toISOString();

    const { fileId, storageObject } = await this.upsertMetadata(
      normalized,
      plaintext.length,
      sha256Param,
      nowIso,
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
  ): Promise<{ fileId: string; storageObject: string }> {
    const { data: existing, error: selectErr } = await this.supabase
      .from("vault_files")
      .select("id, storage_object")
      .eq("workspace_id", this.workspaceId)
      .eq("path", filePath)
      .is("deleted_at", null)
      .maybeSingle();
    if (selectErr) {
      throw new Error(`vault_files lookup failed: ${selectErr.message}`);
    }

    if (existing) {
      const { error: updateErr } = await this.supabase
        .from("vault_files")
        .update({
          size_bytes: plaintextSize,
          plaintext_sha256: sha256Param,
          modified_at: nowIso,
        })
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

    const { error: insertErr } = await this.supabase
      .from("vault_files")
      .insert({
        id: fileId,
        workspace_id: this.workspaceId,
        path: filePath,
        size_bytes: plaintextSize,
        plaintext_sha256: sha256Param,
        mime_type: "text/markdown",
        storage_object: storageObject,
        modified_at: nowIso,
      });

    if (insertErr) {
      // Race lost: another writer inserted at the same path between our
      // SELECT and our INSERT. Re-resolve and UPDATE through the existing
      // row exactly once. A second 23505 surfaces.
      const code = (insertErr as { code?: string }).code;
      if (code === PG_UNIQUE_VIOLATION) {
        const { data: race, error: raceErr } = await this.supabase
          .from("vault_files")
          .select("id, storage_object")
          .eq("workspace_id", this.workspaceId)
          .eq("path", filePath)
          .is("deleted_at", null)
          .single();
        if (raceErr || !race) {
          throw new Error(
            `vault_files race resolve failed: ${raceErr?.message ?? "row vanished"}`,
          );
        }
        const { error: updateErr } = await this.supabase
          .from("vault_files")
          .update({
            size_bytes: plaintextSize,
            plaintext_sha256: sha256Param,
            modified_at: nowIso,
          })
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

  async listFiles(_subPath?: string, _recursive?: boolean): Promise<string[]> {
    throw new Error("NotImplemented: T4.4");
  }

  async exists(_filePath: string): Promise<boolean> {
    throw new Error("NotImplemented: T4.4");
  }

  async mkdir(_dirPath: string): Promise<void> {
    // Deliberate no-op: vault_files only stores leaf .md files; empty dirs
    // are not represented. Implemented in T4.5 only to satisfy the interface.
    throw new Error("NotImplemented: T4.5");
  }

  async delete(_filePath: string): Promise<void> {
    throw new Error("NotImplemented: T4.5");
  }

  async move(_oldPath: string, _newPath: string): Promise<void> {
    throw new Error("NotImplemented: T4.5");
  }

  async stat(_filePath: string): Promise<FileStat> {
    throw new Error("NotImplemented: T4.4");
  }

  async recentFiles(_n: number): Promise<string[]> {
    throw new Error("NotImplemented: T4.4");
  }
}
