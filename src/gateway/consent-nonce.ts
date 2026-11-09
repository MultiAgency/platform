import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * NEP-413 nonces the platform issues for wallet consent and setup texts, as it already picks the nonce a DAO's consent is
 * signed with (`app-dao.ts`). 32 bytes: the issue time (ms, 8 bytes), 8 random bytes, and 16 bytes of an HMAC over both,
 * keyed from the gateway's secret and bound to the host and the app deployment that asked. The owner's signature covers
 * the nonce, so a stored consent proves it was signed no earlier than that time. Nothing is stored. A nonce the app
 * picked itself is still accepted: it just proves nothing about when (`issuedAt` is null).
 */
type Scope = { host: string; deployment: string };
const key = (secret: string) => createHmac("sha256", secret).update("multiagency consent nonce v1").digest();
const tag = (secret: string, { host, deployment }: Scope, head: Buffer) =>
  createHmac("sha256", key(secret)).update(`${host.toLowerCase()}\n${deployment}\n`).update(head).digest().subarray(0, 16);

export function issueNonce(secret: string, scope: Scope, now = Date.now()) {
  const head = Buffer.alloc(16);
  head.writeBigUInt64BE(BigInt(now), 0);
  randomBytes(8).copy(head, 8);
  return { nonce: Buffer.concat([head, tag(secret, scope, head)]).toString("base64"), issuedAt: now };
}

/** When this platform issued `nonce` (base64) for this host and deployment, or null if it didn't. */
export function nonceIssuedAt(secret: string, scope: Scope, nonce: string): number | null {
  const bytes = Buffer.from(nonce, "base64");
  if (bytes.length !== 32) return null;
  const head = bytes.subarray(0, 16);
  if (!timingSafeEqual(tag(secret, scope, head), bytes.subarray(16))) return null;
  return Number(head.readBigUInt64BE(0));
}
