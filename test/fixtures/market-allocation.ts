import {generateKey} from 'near-kit';
import {createPrivateKey,sign} from 'node:crypto';
import {allocationText,type AllocationMessage} from '../../src/market/allocation-types.js';
import {nep413Hash} from '../../src/nep413.js';
const pair = generateKey();
export const allocationOwnerPublicKey = pair.publicKey.toString();
// Use the independent Node signer rather than mirroring the verifier.
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let number = 0n;
for (const c of pair.secretKey.slice(8)) number = number * 58n + BigInt(alphabet.indexOf(c));
const seed = Buffer.from(number.toString(16).padStart(128, "0"), "hex").subarray(0, 32);
const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
const hash = "a".repeat(64);
export const fixtureMessage = (): AllocationMessage => ({
  domain: "multiagency.market-funding-disposition.v1", host: "platform.example", providerOrigin: "https://provider.example",
  ownerAccount: "owner.near", ownerPublicKey: pair.publicKey.toString(), agentId: hash,
  paymentAccount: "b".repeat(64), paymentPublicKey: pair.publicKey.toString(), sourceBindingKey: "source",
  sourceOpen: { correlationId: "open", destinationTxHash: "open-tx", finalHeight: "1" },
  sourceUsdc: { correlationId: "usdc", destinationTxHash: "usdc-tx", finalHeight: "2" }, sourceUsdcAmount: "10000", maxTopUpUsdc: "240000",
  target: { actor: "app:staging:test", requestId: "acceptance-1", brief: "Test",
    approved: { handle: "writer", brief: "532eaabd9574880dbf76b9b8cc00832c20a6ec113d682299550d7a6e0f345e25", network: "near:mainnet",
      asset: "usdc.near", payTo: "market.near", amount: "250000", maxTimeoutSeconds: 600 } },
  reviewedPolicy: { revision: 2, digest: `sha256:${hash}` }, expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: Buffer.alloc(32, 1).toString("base64"),
});
export function signedFixture(message = fixtureMessage()) {
  const text = allocationText(message);
  return { message: text, nonce: message.nonce, publicKey: message.ownerPublicKey,
    signature: sign(null, nep413Hash(text, Buffer.from(message.nonce, "base64"), message.host), privateKey).toString("base64") };
}

