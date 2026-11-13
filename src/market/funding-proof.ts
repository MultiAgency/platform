import { Near } from "near-kit";
import { transactionsApi } from "../fastnear.js";
import { contractOf, mainnet } from "../chain.js";
import { ASSETS } from "../policy.js";

/**
 * The provider's optional destination hash names a transaction, not yet the credit we need. Confirm that the
 * transaction finalized and that one of its successful receipts transferred the exact delivered amount to this
 * payment key. A later chain view must read at or after `blockHeight` before a funding reservation is released.
 * Hashless same-chain routes have no automatic proof here; see docs/market.md.
 */
export type FundingReceipt = { destinationTxHash: string; blockHeight: string; recipient: string; asset: string; amount: string };
export type FundingReceiptReads = {
  transactions(hash: string): Promise<unknown>;
  status(hash: string, signer: string): Promise<unknown>;
  height(blockHash: string): Promise<bigint>;
  /** Read an exact receipt omitted by the final transaction response. */
  receipt?(id: string): Promise<unknown>;
};

const near = new Near(mainnet);
const liveReads: FundingReceiptReads = {
  transactions: hash => transactionsApi("/transactions", { tx_hashes: [hash] }),
  status: (hash, signer) => near.rpc.getTransactionStatus(hash, signer, "FINAL"),
  height: async blockHash => BigInt((await near.rpc.getBlock({ blockId: blockHash })).header.height),
  receipt: id => near.rpc.call("EXPERIMENTAL_receipt", { receipt_id: id }),
};

const HASH = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const AMOUNT = /^[0-9]+$/;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const positive = (value: unknown): value is string =>
  typeof value === "string" && AMOUNT.test(value) && BigInt(value) > 0n;
const success = (value: unknown) => {
  const result = object(value);
  return result !== null && (typeof result.SuccessValue === "string" || typeof result.SuccessReceiptId === "string");
};

type Credit = { amount: bigint; blockHash: string };

/** An exact native NEAR transfer to the opening account, from a successful receipt. */
function nativeCredit(receipt: Record<string, unknown>, outcome: Record<string, unknown>, recipient: string): bigint | null {
  if (receipt.receiver_id !== recipient) return 0n;
  const action = object(object(receipt.receipt)?.Action);
  if (!action || !Array.isArray(action.actions)) return null;
  let total = 0n;
  for (const raw of action.actions) {
    const transfer = object(object(raw)?.Transfer);
    if (!transfer) continue;
    if (!positive(transfer.deposit)) return null;
    total += BigInt(transfer.deposit);
  }
  return success(object(outcome.outcome)?.status) ? total : 0n;
}

/** The token contract's NEP-141 event in a successful receipt, with every transfer to this account counted. */
function tokenCredit(receipt: Record<string, unknown>, outcome: Record<string, unknown>, recipient: string, token: string): bigint | null {
  if (receipt.receiver_id !== token) return 0n;
  const action = object(object(receipt.receipt)?.Action);
  if (!action || !Array.isArray(action.actions)) return null;
  let called = 0n;
  for (const raw of action.actions) {
    const call = object(object(raw)?.FunctionCall);
    if (call?.method_name !== "ft_transfer") continue;
    if (typeof call.args !== "string") return null;
    let rawArgs: unknown;
    try { rawArgs = JSON.parse(Buffer.from(call.args, "base64").toString()); } catch { return null; }
    const args = object(rawArgs);
    if (!args || typeof args.receiver_id !== "string" || !positive(args.amount)) return null;
    if (args.receiver_id === recipient) called += BigInt(args.amount);
  }
  const result = object(outcome.outcome);
  if (!result || !Array.isArray(result.logs)) return null;
  let total = 0n;
  for (const log of result.logs) {
    if (typeof log !== "string") return null;
    if (!log.startsWith("EVENT_JSON:")) continue;
    let raw: unknown;
    try { raw = JSON.parse(log.slice("EVENT_JSON:".length)); } catch { return null; }
    const event = object(raw);
    if (!event) return null;
    if (event.standard !== "nep141" || event.event !== "ft_transfer") continue;
    if (!Array.isArray(event.data) || event.data.length === 0) return null;
    for (const item of event.data) {
      const transfer = object(item);
      if (!transfer || typeof transfer.new_owner_id !== "string" || !positive(transfer.amount)) return null;
      if (transfer.new_owner_id === recipient) total += BigInt(transfer.amount);
    }
  }
  if (called !== total) return null;
  return success(result.status) ? total : total === 0n ? 0n : null;
}

/**
 * Null means the exact credit is not proven, including an absent hash, a read failure, a non-final transaction,
 * malformed evidence, a different account/asset/amount, or an unavailable block. Never infer arrival from balance.
 */
export async function verifyFundingReceipt(input: {
  destinationTxHash?: string | null;
  recipient: string;
  asset: string;
  /** Exact amount the provider says was delivered on terminal SUCCESS, not the requested withdrawal amount. */
  amount: string;
}, reads: FundingReceiptReads = liveReads): Promise<FundingReceipt | null> {
  const { destinationTxHash: hash, recipient, asset, amount } = input;
  if (!hash || !HASH.test(hash) || !recipient || !positive(amount) || (asset !== ASSETS.wNEAR && asset !== ASSETS.USDC)) return null;
  try {
    const indexed = object(await reads.transactions(hash));
    if (!Array.isArray(indexed?.transactions) || indexed.transactions.length !== 1) return null;
    const fromIndex = object(object(indexed.transactions[0])?.transaction);
    if (fromIndex?.hash !== hash || typeof fromIndex.signer_id !== "string" || !fromIndex.signer_id) return null;
    const signer = fromIndex.signer_id;
    const tx = object(await reads.status(hash, signer));
    if (tx?.final_execution_status !== "FINAL" || !success(tx.status)) return null;
    const transaction = object(tx.transaction);
    if (transaction?.hash !== hash || transaction.signer_id !== signer ||
      !Array.isArray(tx.receipts) || !Array.isArray(tx.receipts_outcome)) return null;

    const outcomes = new Map<string, Record<string, unknown>>();
    for (const raw of tx.receipts_outcome) {
      const outcome = object(raw);
      if (!outcome || typeof outcome.id !== "string" || outcomes.has(outcome.id) || !HASH.test(String(outcome.block_hash))) return null;
      outcomes.set(outcome.id, outcome);
    }
    // Final RPC responses can omit a receipt (notably the local receipt when signer=receiver).
    // Recover only IDs already named by this final transaction's outcomes; never ignore an outcome
    // or infer its actions from an event, balance, or another transaction.
    const receipts: unknown[] = [...tx.receipts];
    const present = new Set<string>();
    for (const raw of receipts) {
      const receipt = object(raw);
      if (!receipt || typeof receipt.receipt_id !== "string" || present.has(receipt.receipt_id)) return null;
      present.add(receipt.receipt_id);
    }
    const missing = [...outcomes.keys()].filter(id => !present.has(id));
    if (missing.length > 16 || (missing.length && !reads.receipt)) return null;
    for (const id of missing) {
      const receipt = object(await reads.receipt!(id));
      const outcome = object(outcomes.get(id)?.outcome);
      if (!receipt || receipt.receipt_id !== id || typeof outcome?.executor_id !== "string" ||
        receipt.receiver_id !== outcome.executor_id) return null;
      receipts.push(receipt);
    }
    const seen = new Set<string>(), credits: Credit[] = [];
    for (const raw of receipts) {
      const receipt = object(raw);
      if (!receipt || typeof receipt.receipt_id !== "string" || seen.has(receipt.receipt_id)) return null;
      seen.add(receipt.receipt_id);
      const outcome = outcomes.get(receipt.receipt_id);
      if (!outcome) return null;
      const credit = asset === ASSETS.wNEAR ? nativeCredit(receipt, outcome, recipient)
        : tokenCredit(receipt, outcome, recipient, contractOf(asset));
      if (credit === null) return null;
      if (credit > 0n) credits.push({ amount: credit, blockHash: outcome.block_hash as string });
    }
    if (outcomes.size !== seen.size) return null;
    if (credits.length === 0 || credits.reduce((total, credit) => total + credit.amount, 0n) !== BigInt(amount)) return null;
    let height = 0n;
    for (const credit of credits) {
      const at = await reads.height(credit.blockHash);
      if (at <= 0n) return null;
      if (at > height) height = at;
    }
    return { destinationTxHash: hash, blockHeight: height.toString(), recipient, asset, amount };
  } catch {
    // Missing index/RPC evidence cannot release a reservation. A later status read may retry it.
    return null;
  }
}

/** Narrow test seam for simulated market funding; production uses the live finality checks above. */
export const fundingProof = { verify: verifyFundingReceipt };
