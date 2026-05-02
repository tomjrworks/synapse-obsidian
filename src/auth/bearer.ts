import { createHash } from "node:crypto";

// 30-day bearer TTL — shared by /authorize (oauth.ts) and /signin/exchange.
export const TOKEN_TTL_SECONDS = 30 * 86400;

export function tokenHashHex(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Postgres bytea literal: \x followed by hex. Always pass via this form;
// supabase-js JSON-stringifies a raw Buffer into {"type":"Buffer","data":[...]}
// which Postgres then stores as the literal bytes of that JSON string (T4 trap).
export function tokenHashByteaParam(token: string): string {
  return `\\x${tokenHashHex(token)}`;
}

// XSS defense for HTML interpolation. Encode `&` first or chains break
// (e.g. `<` would become `&amp;lt;`). /security-audit C1 (2026-04-30).
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
