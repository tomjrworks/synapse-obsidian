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
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StorageBackend, FileStat } from "./storage.js";
import { NotFoundError } from "./storage.js";
import { supabaseService } from "../api/supabase.js";
import { unwrapDek } from "../api/crypto.js";

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

  async writeFile(_filePath: string, _content: string): Promise<void> {
    throw new Error("NotImplemented: T4.2");
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
