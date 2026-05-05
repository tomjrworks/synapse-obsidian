import { randomBytes, createHash } from "node:crypto";

// Alphabet matches validation regex [A-HJ-NP-TV-Z2-9] (31 chars).
// Excludes I, O, U (visually confusable with 1, 0) and 0, 1 (confusable with O, I/l).
const ALPHABET = "ABCDEFGHJKLMNPQRSTVWXYZ23456789";

const CODE_REGEX = /^TAP-[A-HJ-NP-TV-Z2-9]{4}-[A-HJ-NP-TV-Z2-9]{4}$/i;

export const PAIR_TTL_MS = 10 * 60 * 1000;
export const PAIR_RATE_LIMIT = 5;

// Generates a fresh "TAP-XXXX-XXXX" pair token (8 random chars, ~39.6 bits entropy).
export function generatePairToken(): string {
  const buf = randomBytes(8);
  const chars = Array.from(buf)
    .map((b) => ALPHABET[b % ALPHABET.length])
    .join("");
  return `TAP-${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

// Returns canonical uppercase "TAP-XXXX-XXXX" form, or null if the input is invalid.
// Accepts "taproot-xxxx-xxxx", "TAPXXXXXXXX" (no dashes), and case variants.
export function canonicalizePairToken(raw: string): string | null {
  const stripped = raw.trim().toUpperCase().replace(/-/g, "");
  if (stripped.length !== 11 || !stripped.startsWith("TAP")) return null;
  const body = stripped.slice(3);
  const canonical = `TAP-${body.slice(0, 4)}-${body.slice(4, 8)}`;
  if (!CODE_REGEX.test(canonical)) return null;
  return canonical;
}

// Returns a Postgres bytea literal (e.g. \xabcd...) for the canonical token.
// Always canonicalize before hashing so mint and redeem produce the same hash.
export function hashPairToken(canonical: string): string {
  return `\\x${createHash("sha256").update(canonical).digest("hex")}`;
}
