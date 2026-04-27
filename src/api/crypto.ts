import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALG = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function loadKek(): Buffer {
  const hex = process.env.TAPROOT_KEK;
  if (!hex || hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(
      'TAPROOT_KEK must be a 64-char hex string (32 bytes). Generate with: node -e \'console.log(require("crypto").randomBytes(32).toString("hex"))\'',
    );
  }
  return Buffer.from(hex, "hex");
}

export function generateDek(): Buffer {
  return randomBytes(32);
}

export function wrapDek(dek: Buffer): Buffer {
  const kek = loadKek();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, kek, iv);
  const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

export function unwrapDek(wrapped: Buffer): Buffer {
  const kek = loadKek();
  const iv = wrapped.subarray(0, IV_LEN);
  const tag = wrapped.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = wrapped.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALG, kek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
