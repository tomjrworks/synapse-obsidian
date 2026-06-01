import { describe, it, expect, vi, afterEach } from "vitest";
import { scanVaultBodies, resolveScanCap } from "../../src/utils/vault.js";
import type { StorageBackend } from "../../src/utils/storage.js";

// ─────────────────────────────────────────────────────────────────────────
// Layer-1 EVALS for the bounded body-scan primitive (Option 2).
//
// The load-bearing assertion is the readFile COUNT: a no-match query over a
// vault larger than the cap must read <= maxFilesScanned files, NOT the whole
// vault. This is what stops the minutes-long full-vault scan that searchVault
// did serially with a dead `break`.
//
// The primitive is env-free and deterministic — opts.maxFilesScanned is an
// explicit number (undefined = legacy unbounded). resolveScanCap() is the
// caller-side env policy (SCAN_FILE_CAP), tested separately.
// ─────────────────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mkBackend(
  files: Record<string, string>,
  opts: { delayMs?: number } = {},
): StorageBackend {
  return {
    readFile: vi.fn(async (p: string) => {
      if (opts.delayMs) await delay(opts.delayMs);
      if (p in files) return files[p];
      throw new Error(`not found: ${p}`);
    }),
    listFiles: vi.fn(async () => Object.keys(files)),
  } as unknown as StorageBackend;
}

function manyFiles(n: number, body: string): Record<string, string> {
  const f: Record<string, string> = {};
  for (let i = 0; i < n; i++) f[`notes/f${i}.md`] = `${body} ${i}`;
  return f;
}

const readCount = (b: StorageBackend) =>
  (b.readFile as ReturnType<typeof vi.fn>).mock.calls.length;

describe("scanVaultBodies — bounded primitive", () => {
  it("EVAL#1 (killer): no-match query reads <= maxFilesScanned, NOT the whole vault", async () => {
    const backend = mkBackend(manyFiles(1000, "irrelevant body text"));
    const out = await scanVaultBodies(backend, "zzznomatchqqq", {
      maxFilesScanned: 300,
      concurrency: 10,
    });
    expect(out.results).toHaveLength(0);
    expect(out.capped).toBe(true);
    expect(out.timedOut).toBe(false);
    expect(out.scannedCount).toBe(300);
    // The fix, encoded: readFile called exactly the cap, never the 1000-file vault.
    expect(readCount(backend)).toBe(300);
  });

  it("EVAL#8 (kill-switch): maxFilesScanned undefined => legacy unbounded full scan", async () => {
    const backend = mkBackend(manyFiles(1000, "irrelevant body text"));
    const out = await scanVaultBodies(backend, "zzznomatchqqq", {
      maxFilesScanned: undefined,
      concurrency: 10,
    });
    expect(out.capped).toBe(false);
    expect(out.scannedCount).toBe(1000);
    expect(readCount(backend)).toBe(1000);
  });

  it("never overshoots the cap when it isn't a multiple of concurrency", async () => {
    const backend = mkBackend(manyFiles(1000, "irrelevant"));
    const out = await scanVaultBodies(backend, "zzznomatch", {
      maxFilesScanned: 305,
      concurrency: 10,
    });
    expect(out.scannedCount).toBe(305);
    expect(readCount(backend)).toBe(305); // 305, not 310 — chunk is sliced to the cap
  });

  it("stops at maxResults without scanning the rest", async () => {
    const backend = mkBackend(manyFiles(500, "everyfile contains match")); // all match
    const out = await scanVaultBodies(backend, "match", {
      maxResults: 5,
      concurrency: 1, // deterministic: one read at a time
      maxFilesScanned: 300,
    });
    expect(out.results).toHaveLength(5);
    expect(out.scannedCount).toBe(5);
    expect(readCount(backend)).toBe(5);
  });

  it("EVAL#4 (priority): a priority-hinted file beyond the cap is still found", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 100; i++) files[`notes/decoy${i}.md`] = "nothing here";
    files["notes/target.md"] = "the specialterm lives here"; // listed LAST
    const backend = mkBackend(files);

    const withPriority = await scanVaultBodies(backend, "specialterm", {
      maxFilesScanned: 3,
      concurrency: 1,
      priorityHints: ["notes/target.md"],
    });
    expect(withPriority.results.some((r) => r.file === "notes/target.md")).toBe(
      true,
    );

    // Same tiny cap, no priority hint → target (101st file) never reached.
    const backend2 = mkBackend(files);
    const noPriority = await scanVaultBodies(backend2, "specialterm", {
      maxFilesScanned: 3,
      concurrency: 1,
    });
    expect(noPriority.results.some((r) => r.file === "notes/target.md")).toBe(
      false,
    );
  });

  it("EVAL#2-core: an in-loop budget stops the scan (timedOut, not capped)", async () => {
    const backend = mkBackend(manyFiles(200, "no match here"), { delayMs: 20 });
    const out = await scanVaultBodies(backend, "zzznomatch", {
      budgetMs: 60,
      maxFilesScanned: 1000,
      concurrency: 10,
    });
    expect(out.timedOut).toBe(true);
    expect(out.capped).toBe(false);
    expect(out.scannedCount).toBeLessThan(200); // did NOT read the whole vault
    // No background churn: once it returns, the read count is frozen.
    const atResolve = readCount(backend);
    await delay(200);
    expect(readCount(backend)).toBe(atResolve);
  }, 5000);

  it("returns matches with title from frontmatter (searchVault parity)", async () => {
    const backend = mkBackend({
      "notes/a.md": "---\ntitle: Alpha Note\n---\n\nhas the keyword apple",
      "notes/b.md": "no relevant content",
    });
    const out = await scanVaultBodies(backend, "apple", {
      maxFilesScanned: 50,
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0].file).toBe("notes/a.md");
    expect(out.results[0].title).toBe("Alpha Note");
    expect(out.results[0].matches[0].text).toContain("apple");
  });
});

describe("resolveScanCap — SCAN_FILE_CAP env policy (cap ON by default)", () => {
  afterEach(() => {
    delete process.env.SCAN_FILE_CAP;
  });

  it("unset => 300 (default: capped)", () => {
    delete process.env.SCAN_FILE_CAP;
    expect(resolveScanCap()).toBe(300);
  });

  it('"0" => undefined (legacy unbounded escape hatch)', () => {
    process.env.SCAN_FILE_CAP = "0";
    expect(resolveScanCap()).toBeUndefined();
  });

  it('"150" => 150 (explicit tune)', () => {
    process.env.SCAN_FILE_CAP = "150";
    expect(resolveScanCap()).toBe(150);
  });

  it("garbage / empty / negative => 300 (safe default)", () => {
    for (const v of ["abc", "", "  ", "-5"]) {
      process.env.SCAN_FILE_CAP = v;
      expect(resolveScanCap()).toBe(300);
    }
  });
});
