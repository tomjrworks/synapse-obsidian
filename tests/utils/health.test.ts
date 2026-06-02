import { describe, it, expect, afterEach } from "vitest";
import {
  resolveDeployCommit,
  buildHealthPayload,
} from "../../src/utils/health.js";

// /health must report which COMMIT is running, not just the version string
// (which is stable across deploys and can't tell new code from old — the
// blind spot that produced a "nothing deployed" note while code was live).

describe("health — deploy visibility", () => {
  afterEach(() => {
    delete process.env.DEPLOY_COMMIT;
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
  });

  it("reports DEPLOY_COMMIT (short) when set", () => {
    process.env.DEPLOY_COMMIT = "bac2d1b9f0c0deadbeef";
    expect(resolveDeployCommit()).toBe("bac2d1b9f0c0");
  });

  it("falls back to RAILWAY_GIT_COMMIT_SHA, then 'unknown'", () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = "abcdef1234567890";
    expect(resolveDeployCommit()).toBe("abcdef123456");
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
    expect(resolveDeployCommit()).toBe("unknown");
  });

  it("payload carries version + commit + bootedAt", () => {
    process.env.DEPLOY_COMMIT = "deadbee";
    const p = buildHealthPayload("0.4.0");
    expect(p).toMatchObject({
      status: "ok",
      server: "taproot",
      version: "0.4.0",
      commit: "deadbee",
    });
    expect(p.bootedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
