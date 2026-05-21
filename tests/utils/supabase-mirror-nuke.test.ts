/**
 * PR #2 (S97) — nukeWorkspace must delete vault_files rows BEFORE removing
 * Storage blobs so a concurrent helper pull cannot observe "row exists,
 * blob missing" and apply a phantom delete against the user's local plaintext.
 *
 * Uses a mock supabase client that records the call sequence of:
 *   from("vault_files").delete(...)
 *   storage.from("vault-blobs").remove(...)
 * Then asserts the order. Also covers the kill-switch revert.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { nukeWorkspace } from "../../src/utils/supabase-mirror.js";

const WS_ID = "ws-test-nuke-0000";

interface CallLog {
  kind: "list" | "rows-delete" | "blobs-remove" | "keys-delete" | "audit";
  detail?: unknown;
}

function makeNukeMock(opts: {
  storageObjects: string[];
  log: CallLog[];
  rowsDeleteErr?: { message: string } | null;
  blobsRemoveErr?: { message: string } | null;
}) {
  // Each `from(...)` call returns a builder whose terminal methods log the
  // operation. supabase-js method chaining is recreated on each from() call.
  const from = vi.fn().mockImplementation((table: string) => {
    if (table === "vault_files") {
      return {
        select: () => ({
          eq: () => ({
            then: (resolve: (v: { data: unknown; error: null }) => unknown) => {
              opts.log.push({ kind: "list", detail: opts.storageObjects });
              return Promise.resolve({
                data: opts.storageObjects.map((s) => ({ storage_object: s })),
                error: null,
              }).then(resolve);
            },
          }),
        }),
        delete: () => ({
          eq: () => {
            opts.log.push({ kind: "rows-delete" });
            return Promise.resolve({
              count: opts.storageObjects.length,
              error: opts.rowsDeleteErr ?? null,
            });
          },
        }),
      };
    }
    if (table === "tenant_keys") {
      return {
        delete: () => ({
          eq: () => {
            opts.log.push({ kind: "keys-delete" });
            return Promise.resolve({ error: null });
          },
        }),
      };
    }
    if (table === "audit_log") {
      return {
        insert: () => {
          opts.log.push({ kind: "audit" });
          return Promise.resolve({ error: null });
        },
      };
    }
    throw new Error(`unexpected from(${table})`);
  });

  const storage = {
    from: () => ({
      remove: (chunk: string[]) => {
        opts.log.push({ kind: "blobs-remove", detail: chunk });
        return Promise.resolve({ error: opts.blobsRemoveErr ?? null });
      },
    }),
  };

  return { from, storage };
}

describe("nukeWorkspace — PR #2 ordering invariant (S97)", () => {
  afterEach(() => {
    delete process.env.MISSING_BLOB_LEGACY_BEHAVIOR;
  });

  it("captures storage_object list, deletes vault_files FIRST, then removes blobs", async () => {
    const log: CallLog[] = [];
    const sb = makeNukeMock({
      storageObjects: [`${WS_ID}/file-1`, `${WS_ID}/file-2`],
      log,
    });

    await nukeWorkspace(sb as never, WS_ID, null);

    // Required order: SELECT → rows DELETE → blobs REMOVE → keys DELETE → audit.
    const kinds = log.map((l) => l.kind);
    expect(kinds[0]).toBe("list");
    const rowsIdx = kinds.indexOf("rows-delete");
    const blobsIdx = kinds.indexOf("blobs-remove");
    const keysIdx = kinds.indexOf("keys-delete");
    expect(rowsIdx).toBeGreaterThan(0);
    expect(blobsIdx).toBeGreaterThan(rowsIdx); // <- the security invariant
    expect(keysIdx).toBeGreaterThan(blobsIdx);
  });

  it("surfaces a clear error if Storage remove fails AFTER rows have been deleted", async () => {
    const log: CallLog[] = [];
    const sb = makeNukeMock({
      storageObjects: [`${WS_ID}/file-1`],
      log,
      blobsRemoveErr: { message: "outage" },
    });

    await expect(nukeWorkspace(sb as never, WS_ID, null)).rejects.toThrow(
      /AFTER vault_files delete/,
    );
    // Rows were already deleted, so the helper observes an empty page on
    // pull — no phantom deletes.
    expect(log.map((l) => l.kind)).toContain("rows-delete");
  });

  it("kill switch: legacy mode runs blobs remove FIRST, then rows delete (pre-PR-#2 order)", async () => {
    process.env.MISSING_BLOB_LEGACY_BEHAVIOR = "1";
    const log: CallLog[] = [];
    const sb = makeNukeMock({
      storageObjects: [`${WS_ID}/file-1`, `${WS_ID}/file-2`],
      log,
    });

    await nukeWorkspace(sb as never, WS_ID, null);

    const kinds = log.map((l) => l.kind);
    const blobsIdx = kinds.indexOf("blobs-remove");
    const rowsIdx = kinds.indexOf("rows-delete");
    expect(blobsIdx).toBeLessThan(rowsIdx);
  });
});
