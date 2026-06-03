import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getRetrievalIndex,
  scoreQuery,
  backfillNullTokens,
  invalidateRetrievalIndex,
  _clearRetrievalIndexCache,
} from "../../src/utils/retrieval-index.js";
import {
  makeSyntheticCorpus,
  SharedVaultStore,
  makeBackend,
  NEEDLE_BODY_TOKEN,
} from "../fixtures/retrieval-pass3/synthetic-vault.js";

// ─────────────────────────────────────────────────────────────────────────
// OVERSIZED-VAULT eval (handoff 2026-06-03 next-action (a)). The in-memory A/B
// harness (retrieval-pass3-evals.test.ts) runs against Tom's ~40-file
// stand-in for his ~1432-file vault — so it can NEVER exercise:
//   1. the uncapped reader at 5k / 15k scale (≥5 / ≥15 pages, needle past row 1000),
//   2. a backfill that outruns the 5-min backend LRU TTL → a SECOND concurrent
//      backfill on a fresh instance whose in-flight WeakSet guard is empty.
//
// Tom's vault backfills in ~20-30s and never crosses an eviction boundary, so
// both classes pass every gate by construction on his shape. These tests
// manufacture the shapes and pin the HONEST bound: the double-backfill is a
// LOAD event (duplicate READS), never a correctness event (writes stay
// idempotent under the .is(null) guard, the column ends correct).
// ─────────────────────────────────────────────────────────────────────────

describe("oversized vault — uncapped coverage at scale", () => {
  beforeEach(
    () =>
      process.env.TAPROOT_RETRIEVAL_V2 &&
      delete process.env.TAPROOT_RETRIEVAL_V2,
  );

  for (const n of [5_000, 15_000]) {
    it(`indexes + scores a needle at the tail of a ${n.toLocaleString()}-file vault`, async () => {
      // All tokens pre-populated (the warm, steady state) — this isolates the
      // READER's reach from the backfill path. Needle sorts dead last (zzz-).
      const corpus = makeSyntheticCorpus({ n });
      const store = new SharedVaultStore(corpus);
      const backend = makeBackend(store); // real PAGE=1000 → n/1000 pages
      _clearRetrievalIndexCache(backend);

      const index = await getRetrievalIndex(backend);

      // Every file reachable — NOT truncated to the capped listFilesMeta's 1000.
      expect(index.n).toBe(n + 1);
      const hits = scoreQuery(index, NEEDLE_BODY_TOKEN);
      expect(hits.length).toBe(1);
      expect(hits[0].path).toMatch(/needle-row-/);
      // A garden-variety filler token must NOT drag the needle down or vanish it.
      expect(scoreQuery(index, "routine").length).toBe(n); // every filler, not the needle
    });
  }
});

describe("oversized vault — backfill drains the whole null column (chunked)", () => {
  it("populates every null row past the 1000 cap, one read each", async () => {
    // 20% cold tail across 6k files = ~1200 nulls → spills past the cap, forces
    // the chunked (concurrency 10) backfill to do >1 page worth of work.
    const corpus = makeSyntheticCorpus({ n: 6_000, nullFraction: 0.2 });
    const store = new SharedVaultStore(corpus);
    const nullPaths = corpus
      .filter((f) => f.tokens === null)
      .map((f) => f.path);
    const initialNulls = store.nullCount();
    expect(initialNulls).toBe(nullPaths.length);
    expect(initialNulls).toBeGreaterThan(1_000); // genuinely past the cap

    const backend = makeBackend(store);
    await backfillNullTokens(backend, nullPaths);

    expect(store.nullCount()).toBe(0);
    // One read + one write per null row — no waste on the single-instance path.
    expect(store.counters.reads).toBe(initialNulls);
    expect(store.counters.writes).toBe(initialNulls);
  });
});

describe("oversized vault — in-flight guard does NOT survive cache eviction (CONCERN #1)", () => {
  // The guard `tokenBackfillInFlight = WeakSet<StorageBackend>` is keyed per
  // backend INSTANCE (retrieval-index.ts:248). Backends evict on a 5-min LRU TTL
  // (backend-cache.ts), so a backfill that runs >5 min (≈15k+ files) gets its
  // instance evicted mid-run; the next request builds a FRESH instance whose
  // empty WeakSet permits a SECOND concurrent backfill re-reading the same blobs.
  // Modeled here by two backends over one store (= two instance identities).

  it("the guard blocks a re-entrant run on the SAME instance", async () => {
    const corpus = makeSyntheticCorpus({ n: 200, nullFraction: 0.25 });
    const store = new SharedVaultStore(corpus);
    const nullPaths = corpus
      .filter((f) => f.tokens === null)
      .map((f) => f.path);

    // Gate every read so the first run parks mid-flight (guard held).
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const backend = makeBackend(store, { onRead: () => gate });

    const first = backfillNullTokens(backend, nullPaths); // parks on the gate
    await Promise.resolve(); // let it reach the first chunk's reads

    // Re-entrant call on the SAME ref — guard is set → returns immediately, no reads.
    await backfillNullTokens(backend, nullPaths);
    expect(store.counters.reads).toBe(0); // nothing read yet — both runs parked/guarded

    release();
    await first;
    // Exactly one read+write per null — the re-entrant call added nothing.
    expect(store.counters.reads).toBe(nullPaths.length);
    expect(store.counters.writes).toBe(nullPaths.length);
  });

  it("a FRESH instance (post-eviction) runs a second backfill — double READS, never double WRITES", async () => {
    const corpus = makeSyntheticCorpus({ n: 400, nullFraction: 0.25 });
    const store = new SharedVaultStore(corpus);
    const nullPaths = corpus
      .filter((f) => f.tokens === null)
      .map((f) => f.path);
    const initialNulls = store.nullCount();

    // Instance A: gated so its backfill is still in flight when A is "evicted".
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    const a = makeBackend(store, { onRead: () => gateA });
    const aDone = backfillNullTokens(a, nullPaths); // parks; A in-flight, no writes yet
    await Promise.resolve();
    expect(store.nullCount()).toBe(initialNulls); // A blocked before any write

    // Eviction: a fresh instance B (new WeakSet identity) handles the next request.
    const b = makeBackend(store); // ungated
    await backfillNullTokens(b, nullPaths); // B's empty guard does NOT see A in-flight
    expect(store.nullCount()).toBe(0); // B fully drained the column
    expect(store.counters.writes).toBe(initialNulls); // each row filled exactly ONCE

    // Now A unblocks and finishes — its writes are null-fill no-ops (rows populated).
    releaseA();
    await aDone;

    // THE HONEST BOUND: writes stayed idempotent (no clobber, no corruption)…
    expect(store.counters.writes).toBe(initialNulls);
    // …but BOTH instances read every blob → the duplicate-READ LOAD event is real.
    expect(store.counters.reads).toBe(initialNulls * 2);
  });
});

describe("oversized vault — partial index self-heals after the backfill", () => {
  it("a cold-tail file is missing pre-backfill, present after invalidation", async () => {
    process.env.TAPROOT_RETRIEVAL_V2 = "1";
    try {
      // The needle starts with NULL tokens (un-backfilled) → absent from the
      // first index. getRetrievalIndex kicks the backfill; after it drains and
      // the cache is invalidated, the next build includes it. No wrong rankings
      // in between — just fewer hits (SPEC's self-healing path).
      const corpus = makeSyntheticCorpus({ n: 50 });
      const needle = corpus.find((f) => f.path.includes("needle-row-"))!;
      needle.tokens = null; // force the needle into the cold tail
      const store = new SharedVaultStore(corpus);
      const backend = makeBackend(store);
      _clearRetrievalIndexCache(backend);

      const before = await getRetrievalIndex(backend);
      expect(scoreQuery(before, NEEDLE_BODY_TOKEN).length).toBe(0); // not yet indexed

      // Drain the fire-and-forget backfill the read just kicked, then rebuild.
      await new Promise((r) => setTimeout(r, 0));
      expect(store.nullCount()).toBe(0);
      invalidateRetrievalIndex(backend);
      const after = await getRetrievalIndex(backend);
      expect(scoreQuery(after, NEEDLE_BODY_TOKEN).map((h) => h.path)).toContain(
        needle.path,
      );
    } finally {
      delete process.env.TAPROOT_RETRIEVAL_V2;
    }
  });
});

afterEach(() => {
  delete process.env.TAPROOT_RETRIEVAL_V2;
});
