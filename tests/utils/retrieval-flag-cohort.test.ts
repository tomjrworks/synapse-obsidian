import { describe, it, expect, afterEach } from "vitest";
import { retrievalV2Enabled } from "../../src/utils/retrieval-index.js";

// ─────────────────────────────────────────────────────────────────────────
// Option A — workspace-allowlist cohort flag (decision 2026-06-03-pass-3-cohort-
// flag-rollout). Resolves review CONCERN #2: TAPROOT_RETRIEVAL_V2 alone is a
// fleet-synchronized flip. The allowlist lets V2 turn on for a NAMED cohort
// (Tom's workspace, then design partners) one at a time, after each is drained.
//
// Resolution order (locked):
//   1. global TAPROOT_RETRIEVAL_V2=1  → ON for everyone (the existing override
//      + the local/stdio single-user default).
//   2. else workspaceId ∈ TAPROOT_RETRIEVAL_V2_WORKSPACES (comma list) → ON.
//   3. else OFF.
//
// The non-Tom shape this pins (single-user dogfooding cannot): two workspaces
// under ONE process env, one ON and one OFF at the same time.
// ─────────────────────────────────────────────────────────────────────────

afterEach(() => {
  delete process.env.TAPROOT_RETRIEVAL_V2;
  delete process.env.TAPROOT_RETRIEVAL_V2_WORKSPACES;
});

describe("retrievalV2Enabled — global env (unchanged behavior)", () => {
  it("is OFF with no env, regardless of workspace", () => {
    expect(retrievalV2Enabled()).toBe(false);
    expect(retrievalV2Enabled("ws-A")).toBe(false);
  });

  it("the global flag turns V2 on for everyone (override + stdio default)", () => {
    process.env.TAPROOT_RETRIEVAL_V2 = "1";
    expect(retrievalV2Enabled()).toBe(true);
    expect(retrievalV2Enabled("ws-A")).toBe(true);
    expect(retrievalV2Enabled("not-in-any-list")).toBe(true);
  });
});

describe("retrievalV2Enabled — workspace allowlist (Option A)", () => {
  it("turns V2 on ONLY for allowlisted workspaces", () => {
    process.env.TAPROOT_RETRIEVAL_V2_WORKSPACES = "ws-A,ws-B";
    expect(retrievalV2Enabled("ws-A")).toBe(true);
    expect(retrievalV2Enabled("ws-B")).toBe(true);
    expect(retrievalV2Enabled("ws-C")).toBe(false);
  });

  it("THE non-Tom shape: two workspaces, one ON one OFF, same process env", () => {
    process.env.TAPROOT_RETRIEVAL_V2_WORKSPACES = "tom-ws";
    expect(retrievalV2Enabled("tom-ws")).toBe(true); // cohort
    expect(retrievalV2Enabled("some-other-user-ws")).toBe(false); // fleet untouched
  });

  it("an allowlist with no workspaceId argument is inert (no global leak)", () => {
    process.env.TAPROOT_RETRIEVAL_V2_WORKSPACES = "ws-A";
    expect(retrievalV2Enabled()).toBe(false);
    expect(retrievalV2Enabled(undefined)).toBe(false);
  });

  it("trims whitespace and ignores empty entries", () => {
    process.env.TAPROOT_RETRIEVAL_V2_WORKSPACES = "  ws-A , , ws-B  ,";
    expect(retrievalV2Enabled("ws-A")).toBe(true);
    expect(retrievalV2Enabled("ws-B")).toBe(true);
    expect(retrievalV2Enabled("")).toBe(false); // empty id never matches
  });

  it("an empty allowlist env matches nothing", () => {
    process.env.TAPROOT_RETRIEVAL_V2_WORKSPACES = "";
    expect(retrievalV2Enabled("ws-A")).toBe(false);
  });

  it("the global flag still wins over an allowlist miss", () => {
    process.env.TAPROOT_RETRIEVAL_V2 = "1";
    process.env.TAPROOT_RETRIEVAL_V2_WORKSPACES = "ws-A";
    expect(retrievalV2Enabled("ws-C")).toBe(true); // global override
  });

  it("re-reads the env live (a cohort change is picked up without a reload)", () => {
    expect(retrievalV2Enabled("ws-A")).toBe(false);
    process.env.TAPROOT_RETRIEVAL_V2_WORKSPACES = "ws-A";
    expect(retrievalV2Enabled("ws-A")).toBe(true);
    process.env.TAPROOT_RETRIEVAL_V2_WORKSPACES = "ws-B";
    expect(retrievalV2Enabled("ws-A")).toBe(false); // dropped from the cohort
  });
});
