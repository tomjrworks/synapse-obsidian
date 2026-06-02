// /health payload. Reports the running COMMIT (not just the version), so
// "is my latest code actually live?" is answerable from one curl instead of
// grepping boot logs. `railway up` strips .git, so the commit can't be derived
// at runtime — it's stamped into the DEPLOY_COMMIT env var at deploy time by
// scripts/deploy.sh (RAILWAY_GIT_COMMIT_SHA is the fallback for git-triggered
// deploys; "unknown" if neither is set, e.g. a bare `railway up`).

const BOOTED_AT = new Date().toISOString();

export function resolveDeployCommit(): string {
  const c = process.env.DEPLOY_COMMIT || process.env.RAILWAY_GIT_COMMIT_SHA;
  if (!c || !c.trim()) return "unknown";
  return c.trim().slice(0, 12);
}

export interface HealthPayload {
  status: "ok";
  server: "taproot";
  version: string;
  commit: string;
  bootedAt: string;
}

export function buildHealthPayload(version: string): HealthPayload {
  return {
    status: "ok",
    server: "taproot",
    version,
    commit: resolveDeployCommit(),
    bootedAt: BOOTED_AT,
  };
}
