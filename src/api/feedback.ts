import { Router } from "express";
import { respondError } from "./respond-error.js";

export function feedbackRouter(): Router {
  const router = Router();

  router.post("/feedback", async (req, res) => {
    const { message, email, source } = req.body ?? {};

    if (
      typeof message !== "string" ||
      message.length < 1 ||
      message.length > 2000
    ) {
      respondError(res, 400, "invalid_message");
      return;
    }
    if (
      source !== undefined &&
      source !== "dashboard" &&
      source !== "marketing"
    ) {
      respondError(res, 400, "invalid_source");
      return;
    }
    if (
      email !== undefined &&
      (typeof email !== "string" || !email.includes("@"))
    ) {
      respondError(res, 400, "invalid_email");
      return;
    }

    const webhookUrl = process.env.DISCORD_FEEDBACK_WEBHOOK_URL;
    if (!webhookUrl) {
      console.error("[feedback] DISCORD_FEEDBACK_WEBHOOK_URL not set");
      res.status(204).send();
      return;
    }

    const sourceTag = source ? `[${source}] ` : "";
    const fromLine = email ? ` — from ${email.replace(/@.+/, "@…")}` : "";
    const content = `💬 Feedback ${sourceTag}${fromLine}\n\n> ${message.slice(0, 1900)}`;

    fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }).catch((err) => {
      console.error("[feedback] Discord webhook failed:", err);
    });

    res.status(204).send();
  });

  return router;
}
