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

export class SupabaseEncryptedMirrorBackend implements StorageBackend {
  constructor(
    private supabase: SupabaseClient,
    private workspaceId: string,
    private dek: Buffer,
  ) {}

  static async forWorkspace(
    _workspaceId: string,
  ): Promise<SupabaseEncryptedMirrorBackend> {
    throw new Error("NotImplemented: T4.1");
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
