/**
 * Stage 1 T4.0 — content crypto unit test.
 *
 * Verifies encryptBlob/decryptBlob round-trip + AEAD failure modes (corrupt
 * ciphertext, corrupt auth tag, wrong DEK). No network, no DB, no env deps —
 * a real DEK is generated locally per run.
 *
 * Run: tsx scripts/test-content-crypto.ts
 */
import { randomBytes } from "node:crypto";
import { encryptBlob, decryptBlob } from "../src/api/crypto.js";

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

console.log("\n→ Content crypto round-trip");

const dek = randomBytes(32);
const wsId = "test-workspace-aad-00000000";

const empty = encryptBlob(Buffer.from(""), dek, wsId);
check(
  "empty plaintext round-trips",
  decryptBlob(empty, dek, wsId).toString("utf8") === "",
);

const small = encryptBlob(Buffer.from("hello world", "utf8"), dek, wsId);
check(
  "small plaintext round-trips",
  decryptBlob(small, dek, wsId).toString("utf8") === "hello world",
);

const utf8 = "🌱 Taproot — your memory layer.\n\n## heading\n\n> quote";
const utf8Blob = encryptBlob(Buffer.from(utf8, "utf8"), dek, wsId);
check(
  "utf-8 + emoji round-trips",
  decryptBlob(utf8Blob, dek, wsId).toString("utf8") === utf8,
);

const big = randomBytes(1024 * 64); // 64 KiB
const bigBlob = encryptBlob(big, dek, wsId);
check(
  "64KiB random plaintext round-trips",
  decryptBlob(bigBlob, dek, wsId).equals(big),
);

const ivOverhead = small.length - "hello world".length;
check(
  "envelope overhead = 29 bytes (1-version + 12-IV + 16-tag)",
  ivOverhead === 29,
  ivOverhead,
);

console.log("\n→ AEAD failure modes");

const ref = encryptBlob(Buffer.from("authentic", "utf8"), dek, wsId);

// Flip one byte in the ciphertext region (after version+iv+tag) — auth tag must reject.
const corruptCt = Buffer.from(ref);
corruptCt[corruptCt.length - 1] ^= 0x01;
expectThrows("corrupt ciphertext byte → throws", () =>
  decryptBlob(corruptCt, dek, wsId),
);

// Flip one byte in the auth tag region — must reject.
const corruptTag = Buffer.from(ref);
corruptTag[13] ^= 0x01; // first tag byte (offset 1 version + 12 iv = 13)
expectThrows("corrupt auth tag byte → throws", () =>
  decryptBlob(corruptTag, dek, wsId),
);

// Flip one byte in the IV — must reject (different IV → different keystream → tag mismatch).
const corruptIv = Buffer.from(ref);
corruptIv[1] ^= 0x01; // first IV byte (offset 1 for version byte)
expectThrows("corrupt IV byte → throws", () =>
  decryptBlob(corruptIv, dek, wsId),
);

// Wrong DEK — must reject.
const wrongDek = randomBytes(32);
expectThrows("wrong DEK → throws", () => decryptBlob(ref, wrongDek, wsId));

// Truncated blob — must reject.
expectThrows("truncated blob → throws", () =>
  decryptBlob(ref.subarray(0, ref.length - 1), dek, wsId),
);

console.log("\n→ Distinct IVs across calls (probabilistic uniqueness)");

const a = encryptBlob(Buffer.from("same plaintext"), dek, wsId);
const b = encryptBlob(Buffer.from("same plaintext"), dek, wsId);
check("same plaintext + same DEK → different ciphertexts", !a.equals(b));

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
