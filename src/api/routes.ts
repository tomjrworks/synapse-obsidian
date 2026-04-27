import { Router, type Express } from "express";
import type { StorageBackend } from "../utils/storage.js";
import { authRouter } from "./auth.js";
import { meRouter } from "./me.js";
import { onboardingRouter } from "./onboarding.js";

export function mountApiRoutes(app: Express, _backend: StorageBackend): void {
  const api = Router();

  api.get("/_ping", (_req, res) => {
    res.json({ ok: true, api: "taproot", scope: "stage1-onboarding" });
  });

  api.use("/", authRouter());
  api.use("/", meRouter());
  api.use("/", onboardingRouter());

  app.use("/api", api);
}
