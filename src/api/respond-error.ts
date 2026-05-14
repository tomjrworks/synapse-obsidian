import type { Response } from "express";
import { randomUUID } from "node:crypto";

export type RespondErrorOptions = {
  /** Extra fields merged into the response body (e.g. allowed:[…], unknown:[…]). */
  extra?: Record<string, unknown>;
  /** Subsystem prefix for the server log line. Defaults to "api". */
  logPrefix?: string;
};

/**
 * Sanctioned exit point for HTTP error responses. Sends a sanitized body
 * `{ error: code, request_id }` to the client and logs the full error
 * server-side with the same request_id for incident triage. Clients never
 * see raw error messages — server logs are the lookup table.
 */
export function respondError(
  res: Response,
  status: number,
  code: string,
  err?: unknown,
  opts: RespondErrorOptions = {},
): void {
  const prefix = opts.logPrefix ?? "api";
  if (res.headersSent) {
    console.error(
      `[${prefix}] respondError after headers sent code=${code} err=`,
      err,
    );
    return;
  }
  const requestId = randomUUID();
  console.error(
    `[${prefix}] code=${code} request_id=${requestId} status=${status} err=`,
    err,
  );

  if (status >= 500) {
    const webhookUrl = process.env.DISCORD_ERROR_WEBHOOK_URL;
    if (webhookUrl) {
      const route =
        (res as unknown as { req?: { path?: string } }).req?.path ?? "?";
      fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `🚨 5xx | ${status} | ${code} | route=${route} | req=${requestId}`,
        }),
      }).catch(() => {});
    }
  }

  res.status(status).json({
    ...(opts.extra ?? {}),
    error: code,
    request_id: requestId,
  });
}

/**
 * For per-op responses inside batch endpoints (e.g. /sync/push results array)
 * where there's no `res` to write to mid-loop. Same sanitization contract:
 * log the full error with a request_id, return the request_id for inclusion
 * in the per-op result entry.
 */
export function logErrorWithId(
  err: unknown,
  code: string,
  logPrefix = "api",
): string {
  const requestId = randomUUID();
  console.error(
    `[${logPrefix}] code=${code} request_id=${requestId} err=`,
    err,
  );
  return requestId;
}
