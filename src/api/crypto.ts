import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALG = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const VERSION_1 = 0x01;

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

// Write format: [0x01 | iv (12B) | tag (16B) | ciphertext]
// The workspace_id is bound as AAD so ciphertexts can't be transplanted
// across tenants.
export function wrapDek(dek: Buffer, workspaceId: string): Buffer {
  const kek = loadKek();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, kek, iv);
  cipher.setAAD(Buffer.from(workspaceId, "utf8"));
  const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION_1]), iv, tag, ct]);
}

// Legacy blobs (no version byte) are decrypted without AAD.
// Versioned blobs require workspaceId — omitting it throws.
export function unwrapDek(wrapped: Buffer, workspaceId?: string): Buffer {
  const kek = loadKek();
  let offset = 0;
  let aad: Buffer | null = null;
  if (wrapped[0] === VERSION_1) {
    if (!workspaceId)
      throw new Error("workspaceId required to unwrap versioned DEK");
    aad = Buffer.from(workspaceId, "utf8");
    offset = 1;
  }
  const iv = wrapped.subarray(offset, offset + IV_LEN);
  const tag = wrapped.subarray(offset + IV_LEN, offset + IV_LEN + TAG_LEN);
  const ct = wrapped.subarray(offset + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALG, kek, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(aad);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// Layout matches wrapDek/unwrapDek: [0x01 | iv | tag | ciphertext]. Distinct names
// from wrapDek/unwrapDek so reviewers don't conflate "encrypt content with DEK"
// with "wrap DEK with KEK" — same primitive, different trust boundary.
export function encryptBlob(
  plaintext: Buffer,
  dek: Buffer,
  workspaceId: string,
): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, dek, iv);
  cipher.setAAD(Buffer.from(workspaceId, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION_1]), iv, tag, ct]);
}

// Legacy blobs (no version byte) are decrypted without AAD.
// Versioned blobs require workspaceId — omitting it throws.
export function decryptBlob(
  blob: Buffer,
  dek: Buffer,
  workspaceId?: string,
): Buffer {
  let offset = 0;
  let aad: Buffer | null = null;
  if (blob[0] === VERSION_1) {
    if (!workspaceId)
      throw new Error("workspaceId required to decrypt versioned blob");
    aad = Buffer.from(workspaceId, "utf8");
    offset = 1;
  }
  const iv = blob.subarray(offset, offset + IV_LEN);
  const tag = blob.subarray(offset + IV_LEN, offset + IV_LEN + TAG_LEN);
  const ct = blob.subarray(offset + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALG, dek, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(aad);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
