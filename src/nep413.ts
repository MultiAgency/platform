import { createHash, createPublicKey, verify } from "node:crypto";

/**
 * NEAR's off-chain signatures, shared by the DAO signer (a DAO's MPC key signs the NEP-413 hash of
 * an owner intent) and sign-in (a member's wallet signs a challenge).
 */

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** `length` bytes from base58 text. */
function base58(text: string, length: number) {
  let n = 0n;
  for (const c of text) {
    const digit = B58.indexOf(c);
    if (digit < 0) throw new Error("Not base58");
    n = n * 58n + BigInt(digit);
  }
  const hex = n.toString(16).padStart(length * 2, "0");
  if (hex.length !== length * 2) throw new Error(`Not ${length} bytes`);
  return Buffer.from(hex, "hex");
}

/** The 32 raw bytes of an `ed25519:<base58>` key. */
export const rawKey = (key: string) => base58(key.replace(/^ed25519:/, ""), 32);

/** A wallet's 64-byte signature, which wallets give as base64 or as `ed25519:<base58>`. */
export function signatureBytes(signature: string) {
  const bytes = signature.startsWith("ed25519:") ? base58(signature.slice("ed25519:".length), 64) : Buffer.from(signature, "base64");
  if (bytes.length !== 64) throw new Error("A signature is 64 bytes");
  return bytes;
}

/** Whether `signature` is `key`'s Ed25519 signature over `message`. */
export function verifyEd25519(key: string, message: Buffer, signature: Buffer) {
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawKey(key)]);
  return verify(null, message, createPublicKey({ key: spki, format: "der", type: "spki" }), signature);
}

/**
 * NEP-413: sha256(borsh(tag 2^31+413) ++ borsh({ message, nonce[32], recipient, callbackUrl })).
 * `callbackUrl` is an Option<String>: some wallets set it to the page that asked, and the signature
 * then covers it.
 */
export function nep413Hash(message: string, nonce: Buffer, recipient: string, callbackUrl?: string | null) {
  if (nonce.length !== 32) throw new Error("A NEP-413 nonce is 32 bytes");
  const str = (s: string) => {
    const bytes = Buffer.from(s, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2 ** 31 + 413);
  const callback = callbackUrl == null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), str(callbackUrl)]);
  return createHash("sha256").update(Buffer.concat([tag, str(message), nonce, str(recipient), callback])).digest();
}

/** A NEP-413 signature as an app relays it: the text, its 32-byte nonce (base64), the signing key and the signature. */
export type SignedText = { message: string; nonce: string; publicKey: string; signature: string };

/** Whether `signed` is a NEP-413 signature over exactly `text` for `host`. Who holds the key is the caller's to check. */
export function signsText(signed: SignedText, host: string, text: string) {
  if (signed.message !== text) return false;
  const nonce = Buffer.from(signed.nonce, "base64");
  if (nonce.length !== 32) return false;
  try { return verifyEd25519(signed.publicKey, nep413Hash(signed.message, nonce, host), signatureBytes(signed.signature)); } catch { return false; }
}
