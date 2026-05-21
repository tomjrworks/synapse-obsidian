/**
 * PR #2 (S99) — writeFile must upload the ciphertext blob BEFORE committing
 * the vault_files metadata row. If the upload fails, no row is committed —
 * eliminating the "metadata row exists, blob missing" window that pull
 * formerly mapped to deleted: true.
 *
 * Uses a mock supabase client that records the call sequence of:
 *   storage.upload(...)
 *   vault_files.insert(...) / update(...)
 * Then asserts upload precedes the metadata write. Also covers the
 * kill-switch revert.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { SupabaseEncryptedMirrorBackend } from "../../src/utils/supabase-mirror.js";

const DUMMY_DEK = Buffer.alloc(32, 0x42);
const WS_ID = "ws-test-writefile-0000";

interface CallLog {
  kind:
    | "select"
    | "insert"
    | "update"
    | "upload"
    | "select-claude-md-rules"
    | "select-index";
  detail?: unknown;
}

function makeWriteFileMock(opts: {
  log: CallLog[];
  existing?: { id: string; storage_object: string; flags?: unknown } | null;
  uploadErr?: { message: string; statusCode?: string | number } | null;
  insertErr?: { message: string; code?: string } | null;
}) {
  // The backend touches multiple tables: vault_files (the metadata),
  // and indirectly the rules cache reads via getRulesForBackend which
  // calls listFiles + readFile. To keep the test simple, mock listFiles
  // to return [] (no CLAUDE.md present) so rules computation skips.

  const builderFactory = (): unknown => {
    // chainable builder that supports the full surface we touch
    const b: Record<string, unknown> = {};
    const noop = () => b;
    b.select = noop;
    b.eq = noop;
    b.is = noop;
    b.order = noop;
    b.limit = noop;
    b.or = noop;
    b.like = noop;
    b.maybeSingle = () =>
      Promise.resolve({ data: opts.existing ?? null, error: null });
    b.single = () =>
      Promise.resolve({ data: opts.existing ?? null, error: null });
    b.then = (resolve: (v: { data: unknown; error: null }) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve);
    return b;
  };

  const fromMock = vi.fn().mockImplementation((table: string) => {
    if (table === "vault_files") {
      const builder = builderFactory() as Record<string, unknown>;
      // Wrap select to log the lookup
      const origSelect = builder.select as () => unknown;
      builder.select = (...args: unknown[]) => {
        opts.log.push({ kind: "select", detail: args });
        return origSelect.apply(builder, args as []);
      };
      builder.insert = (row: unknown) => {
        opts.log.push({ kind: "insert", detail: row });
        return Promise.resolve({
          data: null,
          error: opts.insertErr ?? null,
        });
      };
      builder.update = (row: unknown) => {
        opts.log.push({ kind: "update", detail: row });
        return {
          eq: () => Promise.resolve({ data: null, error: null }),
        };
      };
      return builder;
    }
    // workspace_files or anything else: return empty results
    return builderFactory();
  });

  const storage = {
    from: () => ({
      upload: (key: string, _bytes: Buffer, _opts: unknown) => {
        opts.log.push({ kind: "upload", detail: key });
        return Promise.resolve({ error: opts.uploadErr ?? null });
      },
    }),
  };

  return { from: fromMock, storage };
}

describe("writeFile — PR #2 ordering invariant (S99)", () => {
  afterEach(() => {
    delete process.env.MISSING_BLOB_LEGACY_BEHAVIOR;
  });

  it("new path: uploads blob BEFORE INSERT, and uploads under the same key the row carries", async () => {
    const log: CallLog[] = [];
    const sb = makeWriteFileMock({ log, existing: null });
    const backend = new SupabaseEncryptedMirrorBackend(
      sb as never,
      WS_ID,
      DUMMY_DEK,
    );

    await backend.writeFile("new-note.md", "hello");

    const uploadIdx = log.findIndex((l) => l.kind === "upload");
    const insertIdx = log.findIndex((l) => l.kind === "insert");
    expect(uploadIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    expect(uploadIdx).toBeLessThan(insertIdx);

    // The upload key must match the storage_object the INSERT row carries.
    const uploadKey = log[uploadIdx].detail as string;
    const insertRow = log[insertIdx].detail as { storage_object: string };
    expect(insertRow.storage_object).toBe(uploadKey);
    expect(uploadKey.startsWith(`${WS_ID}/`)).toBe(true);
  });

  it("existing path: uploads blob BEFORE UPDATE, reusing the row's existing storage_object", async () => {
    const log: CallLog[] = [];
    const existingKey = `${WS_ID}/preexisting-file-id`;
    const sb = makeWriteFileMock({
      log,
      existing: {
        id: "preexisting-file-id",
        storage_object: existingKey,
        flags: {},
      },
    });
    const backend = new SupabaseEncryptedMirrorBackend(
      sb as never,
      WS_ID,
      DUMMY_DEK,
    );

    await backend.writeFile("existing-note.md", "updated content");

    const uploadIdx = log.findIndex((l) => l.kind === "upload");
    const updateIdx = log.findIndex((l) => l.kind === "update");
    expect(uploadIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(uploadIdx).toBeLessThan(updateIdx);
    expect(log[uploadIdx].detail).toBe(existingKey);
  });

  it("blob upload failure prevents the metadata row from being committed (S99 invariant)", async () => {
    const log: CallLog[] = [];
    const sb = makeWriteFileMock({
      log,
      existing: null,
      uploadErr: { message: "Bad Request", statusCode: 400 }, // non-transient
    });
    const backend = new SupabaseEncryptedMirrorBackend(
      sb as never,
      WS_ID,
      DUMMY_DEK,
    );

    await expect(backend.writeFile("doomed.md", "content")).rejects.toThrow(
      /Storage upload failed/,
    );
    // The INSERT must NOT have run.
    expect(log.find((l) => l.kind === "insert")).toBeUndefined();
    expect(log.find((l) => l.kind === "update")).toBeUndefined();
  });

  it("kill switch: legacy mode commits the metadata row BEFORE the blob upload (pre-PR-#2 order)", async () => {
    process.env.MISSING_BLOB_LEGACY_BEHAVIOR = "1";
    const log: CallLog[] = [];
    const sb = makeWriteFileMock({ log, existing: null });
    const backend = new SupabaseEncryptedMirrorBackend(
      sb as never,
      WS_ID,
      DUMMY_DEK,
    );

    await backend.writeFile("legacy.md", "content");

    const uploadIdx = log.findIndex((l) => l.kind === "upload");
    const insertIdx = log.findIndex((l) => l.kind === "insert");
    expect(insertIdx).toBeLessThan(uploadIdx);
  });
});
