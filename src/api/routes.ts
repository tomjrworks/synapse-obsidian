import { Router, type Express } from "express";
import type { StorageBackend } from "../utils/storage.js";

export function mountApiRoutes(app: Express, _backend: StorageBackend): void {
  const api = Router();

  api.get("/_ping", (_req, res) => {
    res.json({ ok: true, api: "taproot", scope: "stage1-onboarding" });
  });

  app.use("/api", api);
}
