import { Router, type Express } from "express";
import type { StorageBackend } from "../utils/storage.js";
import { authRouter } from "./auth.js";
import { meRouter } from "./me.js";
import { onboardingRouter } from "./onboarding.js";
import { clientsRouter } from "./clients.js";
import { helperRouter } from "./helper.js";
import { firstWowRouter } from "./first-wow.js";

export function mountApiRoutes(app: Express, backend: StorageBackend): void {
  const api = Router();

  api.get("/_ping", (_req, res) => {
    res.json({ ok: true, api: "taproot", scope: "stage1-onboarding" });
  });

  api.use("/", authRouter());
  api.use("/", meRouter());
  api.use("/", onboardingRouter());
  api.use("/", clientsRouter());
  api.use("/", helperRouter());
  api.use("/", firstWowRouter(backend));

  app.use("/api", api);
}
