import { describe, it, expect } from "vitest";
import {
  getRetrievalIndex,
  scoreQuery,
  invalidateRetrievalIndex,
} from "../../src/utils/retrieval-index.js";
import type { FileTokens } from "../../src/utils/frontmatter.js";
import {
  SharedVaultStore,
  makeBackend,
  type SyntheticFile,
} from "../fixtures/retrieval-pass3/synthetic-vault.js";

// ─────────────────────────────────────────────────────────────────────────
// CONCURRENT-MUTATION-DURING-PAGINATION eval (handoff 2026-06-03 next-action (b)).
//
// listFileTokensMeta pages with OFFSET (.range(from, from+PAGE-1), from += PAGE,
// supabase-mirror.ts:603-624). OFFSET pagination over a LIVE table is not a
// consistent snapshot — a row added or removed before the current window shifts
// every later row, so the same SELECT loop can SKIP a row (delete) or RETURN one
// TWICE (insert). Tom's single-writer vault almost never mutates mid-read, so the
// Tom-shaped harness cannot surface this. A multi-device user (helper sync + a
// live AI write) can.
//
// What these tests pin:
//   • the race is REAL and BOUNDED — at most the rows straddling the mutated page
//     boundary are affected; never wrong tokens, never arbitrary loss;
//   • a delete also leaves a GHOST (a row read before it was deleted) — which is
//     exactly the symptom C10's invalidate-on-delete exists to clear;
//   • an insert produces a DUPLICATE path that buildIndex does NOT dedup → a
//     DOUBLED hit (a NEW finding the single-user harness never showed);
//   • EVERYTHING self-heals on the next clean rebuild (stable column, no
//     concurrent mutation) — the honest "transient, not persistent" bound.
//
// Page size is shrunk to 2 so the OFFSET shift is legible with a handful of rows;
// the mechanic is identical at PAGE=1000.
// ─────────────────────────────────────────────────────────────────────────

const PAGE = 2;

function tok(body: string): FileTokens {
  return { frontmatter: [], body: [body], identifiers: [] };
}

/** Six files r1..r6 at notes/file-N.md, each with a unique retrievable body token tN. */
function sixFiles(): SyntheticFile[] {
  return Array.from({ length: 6 }, (_, i) => {
    const n = i + 1;
    return {
      path: `notes/file-${n}.md`,
      content: `# File ${n}\n\nbody token t${n}`,
      tokens: tok(`t${n}`),
    };
  });
}

const pathOf = (n: number) => `notes/file-${n}.md`;

describe("pagination race — DELETE between pages skips a row + leaves a ghost", () => {
  it("transiently misses the boundary row and serves the deleted row as a ghost", async () => {
    // store: [f1,f2,f3,f4,f5,f6]. Delete f2 right after page 0 ([f1,f2]) is read.
    //   page0 from0 → [f1,f2]; then delete f2 → store [f1,f3,f4,f5,f6]
    //   page1 from2 → slice(2,4) = [f4,f5]  → f3 SKIPPED (shifted into the read region)
    //   page2 from4 → [f6] → break
    // meta = [f1, f2(ghost), f4, f5, f6]; f3 transiently missed.
    const store = new SharedVaultStore(sixFiles());
    let mutated = false;
    const backend = makeBackend(store, {
      page: PAGE,
      onPage: (pageIndex) => {
        if (pageIndex === 0 && !mutated) {
          mutated = true;
          store.deletePath(pathOf(2));
        }
      },
    });

    const index = await getRetrievalIndex(backend);

    // f3 is the transient miss — the row OFFSET jumped over.
    expect(scoreQuery(index, "t3").length).toBe(0);
    // f2 is the ghost — read on page 0 before it was deleted. Still served until
    // an invalidation clears the cache. THIS is the C10 symptom (delete() must
    // call invalidateIndexForWorkspace, or garden_find ranks a deleted note).
    expect(scoreQuery(index, "t2").map((h) => h.path)).toEqual([pathOf(2)]);
    // Bound: every OTHER row is intact and correctly ranked.
    for (const n of [1, 4, 5, 6]) {
      expect(scoreQuery(index, `t${n}`).map((h) => h.path)).toEqual([
        pathOf(n),
      ]);
    }
  });

  it("self-heals on the next clean rebuild after invalidation (the C10 path)", async () => {
    const store = new SharedVaultStore(sixFiles());
    let mutated = false;
    const racing = makeBackend(store, {
      page: PAGE,
      onPage: (pageIndex) => {
        if (pageIndex === 0 && !mutated) {
          mutated = true;
          store.deletePath(pathOf(2));
        }
      },
    });
    await getRetrievalIndex(racing); // builds the racy index (ghost f2, missing f3)

    // delete()/move() invalidate the cache (C10). Rebuild over the now-stable
    // store (f2 really gone, no concurrent mutation) → both defects clear.
    invalidateRetrievalIndex(racing);
    const healed = await getRetrievalIndex(makeBackend(store, { page: PAGE }));

    expect(scoreQuery(healed, "t2").length).toBe(0); // ghost gone
    expect(scoreQuery(healed, "t3").map((h) => h.path)).toEqual([pathOf(3)]); // miss healed
    for (const n of [1, 4, 5, 6]) {
      expect(scoreQuery(healed, `t${n}`).map((h) => h.path)).toEqual([
        pathOf(n),
      ]);
    }
  });
});

describe("pagination race — INSERT between pages duplicates a row (NEW finding)", () => {
  it("returns a path twice → buildIndex does NOT dedup → a doubled hit", async () => {
    // store: [f1..f6]. Insert f0 (sorts FIRST) right after page 0 ([f1,f2]).
    //   page0 from0 → [f1,f2]; then insert f0 → store [f0,f1,f2,f3,f4,f5,f6]
    //   page1 from2 → slice(2,4) = [f2,f3] → f2 DUPLICATED (already on page 0)
    //   page2 from4 → [f4,f5]; page3 from6 → [f6]; break
    // meta = [f1, f2, f2, f3, f4, f5, f6]; f0 missed this round.
    const store = new SharedVaultStore(sixFiles());
    let mutated = false;
    const backend = makeBackend(store, {
      page: PAGE,
      onPage: (pageIndex) => {
        if (pageIndex === 0 && !mutated) {
          mutated = true;
          store.insertFile({
            path: pathOf(0),
            content: "# File 0\n\nbody token t0",
            tokens: tok("t0"),
          });
        }
      },
    });

    const index = await getRetrievalIndex(backend);

    // FINDING: the duplicated path yields TWO records → a doubled hit. Non-corrupting
    // (same correct tokens, self-heals next rebuild) but a user can briefly see the
    // same note listed twice. getRetrievalIndex/buildIndex have no path-dedup pass.
    const f2hits = scoreQuery(index, "t2").filter((h) => h.path === pathOf(2));
    expect(f2hits.length).toBe(2);
    // f0 (the insert) is missed this round — it landed before the read offset.
    expect(scoreQuery(index, "t0").length).toBe(0);
  });

  it("self-heals on the next clean rebuild — single hit, insert now visible", async () => {
    const store = new SharedVaultStore(sixFiles());
    let mutated = false;
    const racing = makeBackend(store, {
      page: PAGE,
      onPage: (pageIndex) => {
        if (pageIndex === 0 && !mutated) {
          mutated = true;
          store.insertFile({
            path: pathOf(0),
            content: "# File 0\n\nbody token t0",
            tokens: tok("t0"),
          });
        }
      },
    });
    await getRetrievalIndex(racing);

    const healed = await getRetrievalIndex(makeBackend(store, { page: PAGE }));
    expect(scoreQuery(healed, "t2").map((h) => h.path)).toEqual([pathOf(2)]); // dedup'd by re-read
    expect(scoreQuery(healed, "t0").map((h) => h.path)).toEqual([pathOf(0)]); // insert now seen
  });

  // DESIRED property, not yet built (encoded as the fix target the way C4 skipped
  // the A2 gate before C5 wired it). Activate when a path-dedup pass lands in
  // getRetrievalIndex/buildIndex so an in-flight OFFSET race can never double a
  // hit even mid-race. Until then, the self-heal above is the only guarantee.
  it.skip("DESIRED: a mid-race duplicate path collapses to a single record", async () => {
    const store = new SharedVaultStore(sixFiles());
    let mutated = false;
    const backend = makeBackend(store, {
      page: PAGE,
      onPage: (pageIndex) => {
        if (pageIndex === 0 && !mutated) {
          mutated = true;
          store.insertFile({
            path: pathOf(0),
            content: "# File 0\n\nbody token t0",
            tokens: tok("t0"),
          });
        }
      },
    });
    const index = await getRetrievalIndex(backend);
    expect(scoreQuery(index, "t2").map((h) => h.path)).toEqual([pathOf(2)]);
  });
});
