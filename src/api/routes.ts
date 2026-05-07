import { Router, type Express } from "express";
import { meRouter } from "./me.js";
import { onboardingRouter } from "./onboarding.js";
import { clientsRouter } from "./clients.js";
import { helperRouter } from "./helper.js";
import { firstWowRouter } from "./first-wow.js";
import { personaRouter } from "./persona.js";
import { onboardingRulesRouter } from "./onboarding-rules.js";
import { syncRouter } from "./sync.js";
import { workspaceCreateRouter } from "./workspace-create.js";

export function mountApiRoutes(app: Express): void {
  const api = Router();

  api.get("/_ping", (_req, res) => {
    res.json({ ok: true, api: "taproot", scope: "stage1-onboarding" });
  });

  api.use("/", meRouter());
  api.use("/", onboardingRouter());
  api.use("/", clientsRouter());
  api.use("/", helperRouter());
  api.use("/", firstWowRouter());
  api.use("/", personaRouter());
  api.use("/", onboardingRulesRouter());
  api.use("/", syncRouter());
  api.use("/", workspaceCreateRouter());

  app.use("/api", api);
}
