import { AccessKeyDoesNotExistError, AccountDoesNotExistError, Near } from "near-kit";
import { mainnet } from "../chain.js";

/**
 * Whether an x402 payment moved money, from the chain only (docs/market.md, "When a payment is resolved"). A signed
 * delegate action can be relayed by whoever holds it until its `max_block_height`, whatever the task does, so the
 * task's state never decides it. The payment key signs nothing else, and no top-up runs while a payment is unresolved,
 * so between signing and resolution only this delegate action can change the key's nonce or lower its balance.
 */

/** What was recorded when the payment was signed. */
export type Signed = { nonce: bigint; maxBlockHeight: bigint; amount: bigint; balanceAtSigning: bigint };
/** One final block's view of the payment key: its access-key nonce (null: no such key) and token balance. */
export type ChainView = { height: bigint; keyNonce: bigint | null; balance: bigint };

export type PaymentOutcome = "paid" | "not_charged" | "unknown";

export function paymentOutcome(signed: Signed, chain: ChainView): PaymentOutcome {
  const used = chain.keyNonce !== null && chain.keyNonce >= signed.nonce;
  // Relayed, and the transfer landed: the key's only spend is this one.
  if (used && chain.balance === signed.balanceAtSigning - signed.amount) return "paid";
  // Never relayed, and now it can't be: a delegate action is refused past its max_block_height.
  if (!used && chain.height > signed.maxBlockHeight) return "not_charged";
  // Still relayable, or relayed with a transfer not (yet) seen, or a balance something else moved: a person decides.
  return "unknown";
}

const near = new Near(mainnet);

/**
 * The payment key at one final block. A read that fails is no answer and throws; only the chain's "no such key" is null:
 * mainnet answers `result.error` "access key … does not exist while viewing" for a missing key and for an account that
 * never existed alike (FastNear, 2026-11-09), which near-kit raises as `AccessKeyDoesNotExistError`.
 */
export async function readChainView(account: string, publicKey: string, asset: string): Promise<ChainView> {
  // The balance at the latest final block names that block; the key is read at the same one.
  const read = await near.rpc.viewFunction(asset, "ft_balance_of", { account_id: account }, { finality: "final" });
  const balance = JSON.parse(Buffer.from(read.result).toString()) as unknown;
  if (typeof balance !== "string" || !/^[0-9]+$/.test(balance)) throw new Error(`${asset} gave no balance for ${account}`);
  const keyNonce = await near.rpc.getAccessKey(account, publicKey, { blockId: read.block_height }).then(key => BigInt(key.nonce), (error: unknown) => {
    if (error instanceof AccessKeyDoesNotExistError || error instanceof AccountDoesNotExistError) return null;
    throw error;
  });
  return { height: BigInt(read.block_height), keyNonce, balance: BigInt(balance) };
}
