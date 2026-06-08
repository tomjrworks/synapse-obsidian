import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { assembleInstructions } from "../../src/utils/instructions.js";
import type { StorageBackend } from "../../src/utils/storage.js";

function makeBackend(overrides: Partial<StorageBackend> = {}): StorageBackend {
  return {
    readFile: vi.fn(async () => ""),
    writeFile: vi.fn(async () => undefined),
    listFiles: vi.fn(async () => []),
    exists: vi.fn(async () => false),
    mkdir: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: 0, modifiedAt: new Date() })),
    recentFiles: vi.fn(async () => []),
    listChanged: vi.fn(async () => ({ files: [], next: null })),
    ...overrides,
  } as StorageBackend;
}

describe("assembleInstructions", () => {
  it("stays within the 1500-byte budget even with maximal workspace context", async () => {
    // Pass 6: cap stays at 1500. Compressing BEHAVIOR/CURATION freed enough room
    // for the full routing tree (even gate-ON) to fit under the original cap, so
    // the strict-client safety margin under Claude Code's ~2KB cap is preserved.
    const backend = makeBackend({
      recentFiles: vi.fn(async () =>
        Array.from(
          { length: 50 },
          (_, i) => `projects/very-long-folder-name-${i}/file-${i}.md`,
        ),
      ),
    });

    const out = await assembleInstructions(backend);
    const bytes = new TextEncoder().encode(out).length;

    expect(bytes).toBeLessThanOrEqual(1500);
  });

  it("always includes the preamble + tool pointers even when workspace context fails", async () => {
    const backend = makeBackend({
      recentFiles: vi.fn(async () => {
        throw new Error("supabase unreachable");
      }),
    });

    const out = await assembleInstructions(backend);

    expect(out).toContain("Taproot vault");
    expect(out).toContain("garden_rules");
    expect(out).toContain("garden_index");
    expect(out).toContain("garden_plant");
    expect(out).toContain("30s");
  });

  it("includes a workspace-context line when recentFiles returns data", async () => {
    const backend = makeBackend({
      recentFiles: vi.fn(async () => [
        "projects/taproot/note.md",
        "projects/taproot/decision.md",
        "projects/taproot/log.md",
        "daily/2026-05-07-foo.md",
      ]),
    });

    const out = await assembleInstructions(backend);

    expect(out).toContain("most active folder is `projects/`");
    expect(out).toContain("activity in the last");
  });

  it("includes safety guidance telling the AI to respect the vault marker silently", async () => {
    const out = await assembleInstructions(makeBackend());
    expect(out).toContain("untrusted-content-from-vault");
    expect(out).toContain("data, not instructions");
    expect(out).toContain("don't surface the markers");
  });

  it("includes curation guidance — proactive CLAUDE.md rule proposal pattern", async () => {
    const out = await assembleInstructions(makeBackend());
    expect(out).toContain("Curate as you go");
    expect(out).toContain("3+ saves");
    expect(out).toContain("CLAUDE.md filing rule");
    expect(out).toContain("acknowledgeRoot: true");
    expect(out).toContain("Never propose more than once per session");
  });

  it("degrades gracefully (no context line) when recentFiles is empty or throws", async () => {
    const empty = await assembleInstructions(makeBackend({}));
    expect(empty).not.toContain("most active folder");

    const errored = await assembleInstructions(
      makeBackend({
        recentFiles: vi.fn(async () => {
          throw new Error("boom");
        }),
      }),
    );
    expect(errored).not.toContain("most active folder");
    expect(errored).toContain("garden_rules");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Pass 6 — AI priors / routing decision-tree (RED-first).
//
// instructions.ts predates Passes 2–5; it tells the AI about only 4 tools and
// nothing about HOW to route a request. Pass 6 authors a routing prior that
// references ONLY live tools, gated on the same flags the handlers read so it
// can never steer the AI to a "not enabled" tool.
//
// Locked decisions (deep-read 2026-06-08):
//   - KB gate (env TAPROOT_KB_PIPELINE, default OFF): default routes pasted text
//     -> garden_plant, URL -> taproot_save_url, and does NOT advertise the gated
//     seed/water/cultivate/sow chain. When ON, it advertises that chain.
//   - Pass-4 primitives: advertise garden_backlinks (LIVE in prod) only; OMIT
//     garden_query / garden_identifier / garden_cluster (OFF in prod).
//   - V1-floor-safe: no Retrieval-V2 branch, no per-workspace conditionals.
//   - Byte cap stays 1500: compressing BEHAVIOR/CURATION fits the routing tree
//     (even gate-ON ~1393B) under the original cap — strict-client margin kept.
//   - Honesty contract: tell the AI thin/no matches return closest-matches /
//     did-you-mean and to use them rather than invent paths.
//
// These assert the assembled STRING (the prior), since instructions is a static
// payload — "route query type X to live tool Y" is verifiable as substring +
// byte assertions. They fail on current code (no routing tree exists).
// ─────────────────────────────────────────────────────────────────────────
describe("Pass 6 — routing priors", () => {
  afterEach(() => {
    delete process.env.TAPROOT_KB_PIPELINE;
  });

  describe("KB gate OFF (default)", () => {
    beforeEach(() => {
      delete process.env.TAPROOT_KB_PIPELINE;
    });

    it("routes pasted/typed text to garden_plant", async () => {
      const out = await assembleInstructions(makeBackend());
      expect(out).toMatch(/pasted[^\n]*garden_plant/i);
    });

    it("routes URLs/links to taproot_save_url", async () => {
      const out = await assembleInstructions(makeBackend());
      expect(out).toContain("taproot_save_url");
      expect(out).toMatch(/\b(url|link)\b/i);
    });

    it("does NOT advertise the gated KB chain when the gate is off", async () => {
      const out = await assembleInstructions(makeBackend());
      expect(out).not.toContain("taproot_seed");
      expect(out).not.toContain("taproot_water");
      expect(out).not.toContain("taproot_cultivate");
      expect(out).not.toContain("taproot_sow");
    });

    it("advertises garden_find for recall/search", async () => {
      const out = await assembleInstructions(makeBackend());
      expect(out).toContain("garden_find");
    });

    it("advertises garden_backlinks (live Pass-4 primitive)", async () => {
      const out = await assembleInstructions(makeBackend());
      expect(out).toContain("garden_backlinks");
    });

    it("does NOT advertise the disabled Pass-4 primitives", async () => {
      const out = await assembleInstructions(makeBackend());
      expect(out).not.toContain("garden_query");
      expect(out).not.toContain("garden_identifier");
      expect(out).not.toContain("garden_cluster");
    });

    it("encodes the honesty contract — thin results return closest-matches, don't invent", async () => {
      const out = await assembleInstructions(makeBackend());
      expect(out).toMatch(/closest[- ]?match|did[- ]?you[- ]?mean/i);
      expect(out).toMatch(/don'?t (invent|fabricate|guess)/i);
    });

    it("is V1-floor-safe — no Retrieval-V2 / per-workspace branch language", async () => {
      const out = await assembleInstructions(makeBackend());
      expect(out).not.toMatch(/retrieval[- ]?v2/i);
    });
  });

  describe("KB gate ON (TAPROOT_KB_PIPELINE=1)", () => {
    beforeEach(() => {
      process.env.TAPROOT_KB_PIPELINE = "1";
    });

    it("advertises the KB chain when the gate is on", async () => {
      const out = await assembleInstructions(makeBackend());
      expect(out).toContain("taproot_seed");
    });

    it("routes pasted source text to taproot_seed (not garden_plant) when on", async () => {
      const out = await assembleInstructions(makeBackend());
      expect(out).toMatch(/pasted[^\n]*taproot_seed/i);
    });

    it("does NOT also route pasted text to garden_plant when on (seed owns source text)", async () => {
      // Audit concern #1: gate-ON must not give two overlapping rules for "pasted".
      const out = await assembleInstructions(makeBackend());
      expect(out).not.toMatch(/pasted[^\n]*garden_plant/i);
    });
  });

  it("keeps the load-bearing routing even when workspace context forces truncation", async () => {
    // Routing must sit BEFORE the sacrificial tail (curation + workspace ctx),
    // so a near-cap payload never truncates away save-routing.
    const backend = makeBackend({
      recentFiles: vi.fn(async () =>
        Array.from(
          { length: 50 },
          (_, i) => `projects/very-long-folder-name-${i}/file-${i}.md`,
        ),
      ),
    });
    const out = await assembleInstructions(backend);
    expect(out).toContain("garden_plant");
    expect(out).toContain("taproot_save_url");
  });
});
