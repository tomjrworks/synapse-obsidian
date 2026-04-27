import { Router, type Express } from "express";
import type { StorageBackend } from "../utils/storage.js";
import { authRouter } from "./auth.js";
import { meRouter } from "./me.js";
import { onboardingRouter } from "./onboarding.js";
import { clientsRouter } from "./clients.js";
import { helperRouter } from "./helper.js";

export function mountApiRoutes(app: Express, _backend: StorageBackend): void {
  const api = Router();

  api.get("/_ping", (_req, res) => {
    res.json({ ok: true, api: "taproot", scope: "stage1-onboarding" });
  });

  api.use("/", authRouter());
  api.use("/", meRouter());
  api.use("/", onboardingRouter());
  api.use("/", clientsRouter());
  api.use("/", helperRouter());

  app.use("/api", api);
}
