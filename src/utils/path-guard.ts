import path from "node:path";

// Paths protected by EXACT canonical match (never written without acknowledgeRoot).
const PROTECTED_EXACT = new Set(["index.md", ".taproot/config.json"]);

// Basenames protected at ANY depth in the vault. Without this, an attacker writes
// `notes/CLAUDE.md` and Claude Code's nested-CLAUDE.md walker auto-loads it next
// session — same prompt-injection backdoor as root CLAUDE.md.
const PROTECTED_BASENAMES = new Set(["claude.md"]);

/** Canonicalize a vault-relative POSIX path for guard comparison.
 *  Returns null if the input is structurally invalid (NUL, absolute, contains
 *  literal `\`, or escapes the vault via `..`). */
export function canonicalProtectedForm(filePath: string): string | null {
  if (filePath.includes("\0")) return null;
  if (path.isAbsolute(filePath)) return null;
  if (filePath.includes("\\")) return null;
  const nfc = filePath.normalize("NFC");
  const norm = path.posix.normalize(nfc).replace(/\/+$/, "").toLowerCase();
  if (norm === ".." || norm.startsWith("../")) return null;
  return norm;
}

export type ProtectionResult =
  | { kind: "ok" }
  | { kind: "invalid"; reason: string }
  | { kind: "protected"; canonical: string };

export function checkProtected(filePath: string): ProtectionResult {
  const canonical = canonicalProtectedForm(filePath);
  if (canonical === null) {
    return {
      kind: "invalid",
      reason:
        "Path is invalid (absolute, traversal, or contains backslash/NUL).",
    };
  }
  if (PROTECTED_EXACT.has(canonical)) {
    return { kind: "protected", canonical };
  }
  const base = path.posix.basename(canonical);
  if (PROTECTED_BASENAMES.has(base)) {
    return { kind: "protected", canonical };
  }
  return { kind: "ok" };
}
