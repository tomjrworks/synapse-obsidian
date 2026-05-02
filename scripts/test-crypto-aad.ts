/**
 * PR2 — AAD + version-byte smoke test.
 *
 * Verifies:
 * - New blobs have version byte 0x01 prefix
 * - AAD binding: wrong workspaceId on decrypt → throws
 * - Missing workspaceId on versioned blob → throws
 * - Legacy blobs (no version byte) decrypt without AAD
 * - wrapDek/unwrapDek round-trip with AAD
 * - Legacy wrapped DEK (no version byte) unwraps without workspaceId
 *
 * No network, no DB, no env deps — real KEK generated per run.
 *
 * Run: tsx scripts/test-crypto-aad.ts
 */
import { randomBytes } from "node:crypto";

// Set a fake KEK so crypto.ts can load
process.env.TAPROOT_KEK = randomBytes(32).toString("hex");

import {
  decryptBlob,
  encryptBlob,
  generateDek,
  unwrapDek,
  wrapDek,
} from "../src/api/crypto.js";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}: ${JSON.stringify(detail)}`);
    console.log(`  ✗ ${name}  →  ${JSON.stringify(detail)}`);
  }
}

function expectThrows(name: string, fn: () => unknown) {
  try {
    fn();
    check(name, false, "expected throw, got success");
  } catch {
    check(name, true);
  }
}

const dek = generateDek();
const wsA = "workspace-aaa-00000000-0000-0000-0000-000000000000";
const wsB = "workspace-bbb-11111111-1111-1111-1111-111111111111";

// ── encryptBlob / decryptBlob ────────────────────────────────────────────────

console.log("\n→ encryptBlob: version byte");

const blob = encryptBlob(Buffer.from("hello"), dek, wsA);
check("versioned blob starts with 0x01", blob[0] === 0x01, blob[0]);

console.log("\n→ decryptBlob: AAD binding");

check(
  "correct workspaceId → decrypts",
  decryptBlob(blob, dek, wsA).toString("utf8") === "hello",
);
expectThrows("wrong workspaceId → throws", () => decryptBlob(blob, dek, wsB));
expectThrows("missing workspaceId on versioned blob → throws", () =>
  decryptBlob(blob, dek),
);

console.log("\n→ decryptBlob: legacy path (no version byte)");

// Craft a legacy blob: [iv (12B) | tag (16B) | ciphertext] — no version prefix.
// Build it with raw Node crypto to simulate a pre-PR2 write.
import { createCipheriv } from "node:crypto";
const iv = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", dek, iv);
const ct = Buffer.concat([
  cipher.update(Buffer.from("legacy content", "utf8")),
  cipher.final(),
]);
const tag = cipher.getAuthTag();
const legacyBlob = Buffer.concat([iv, tag, ct]);

check(
  "legacy blob (no version byte) decrypts without workspaceId",
  decryptBlob(legacyBlob, dek).toString("utf8") === "legacy content",
);
check(
  "legacy blob also decrypts when workspaceId supplied (ignored for legacy)",
  decryptBlob(legacyBlob, dek, wsA).toString("utf8") === "legacy content",
);

// ── wrapDek / unwrapDek ──────────────────────────────────────────────────────

console.log("\n→ wrapDek: version byte");

const wrapped = wrapDek(dek, wsA);
check(
  "versioned wrapped DEK starts with 0x01",
  wrapped[0] === 0x01,
  wrapped[0],
);

console.log("\n→ unwrapDek: AAD binding");

const unwrapped = unwrapDek(wrapped, wsA);
check("correct workspaceId → unwraps to original DEK", unwrapped.equals(dek));
expectThrows("wrong workspaceId → throws", () => unwrapDek(wrapped, wsB));
expectThrows("missing workspaceId on versioned wrapped DEK → throws", () =>
  unwrapDek(wrapped),
);

console.log("\n→ unwrapDek: legacy path (no version byte)");

// Build a legacy wrapped DEK (pre-PR2 format) without version byte.
const legacyIv = randomBytes(12);
const wrapCipher = createCipheriv(
  "aes-256-gcm",
  Buffer.from(process.env.TAPROOT_KEK!, "hex"),
  legacyIv,
);
const wrappedCt = Buffer.concat([wrapCipher.update(dek), wrapCipher.final()]);
const wrapTag = wrapCipher.getAuthTag();
const legacyWrapped = Buffer.concat([legacyIv, wrapTag, wrappedCt]);

check(
  "legacy wrapped DEK (no version byte) unwraps without workspaceId",
  unwrapDek(legacyWrapped).equals(dek),
);
check(
  "legacy wrapped DEK also unwraps when workspaceId supplied (ignored for legacy)",
  unwrapDek(legacyWrapped, wsA).equals(dek),
);

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
