import assert from "node:assert/strict";
import { test } from "node:test";
import { contractOf } from "../src/chain.js";
import { ASSETS } from "../src/policy.js";
import { verifyFundingReceipt, type FundingReceiptReads } from "../src/market/funding-proof.js";

const HASH = "H".repeat(43), SIGNER = "bridge.near", BLOCK = "B".repeat(43);
const ACCOUNT = "buyer.near", USDC = contractOf(ASSETS.USDC);
const transfer = (amount = "500000", recipient = ACCOUNT) => `EVENT_JSON:${JSON.stringify({
  standard: "nep141", version: "1.0.0", event: "ft_transfer", data: [{ old_owner_id: "bridge.near", new_owner_id: recipient, amount }],
})}`;
const receipt = (id: string, receiver_id: string, actions: unknown[], logs: string[] = []) => ({
  receipt_id: id, receiver_id, receipt: { Action: { actions } },
  logs,
});
const native = receipt("r-native", ACCOUNT, [{ CreateAccount: {} }, { Transfer: { deposit: "20000000000000000000000" } }]);
const token = receipt("r-token", USDC, [{ FunctionCall: { method_name: "ft_transfer",
  args: Buffer.from(JSON.stringify({ receiver_id: ACCOUNT, amount: "500000" })).toString("base64") } }], [transfer()]);

function fixture(credits = [token], overrides: { status?: Record<string, unknown>; transaction?: Record<string, unknown> } = {}) {
  const receipts = credits.map(({ logs, ...r }) => r);
  const receipts_outcome = credits.map(({ receipt_id, logs }) => ({ id: receipt_id, block_hash: BLOCK,
    outcome: { status: { SuccessValue: "" }, logs } }));
  return { final_execution_status: "FINAL", status: { SuccessValue: "" }, transaction: { hash: HASH, signer_id: SIGNER, ...overrides.transaction },
    receipts, receipts_outcome, ...overrides.status };
}

function reads(status = fixture()): FundingReceiptReads & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    transactions: async hash => { calls.push(`index:${hash}`); return { transactions: [{ transaction: { hash: HASH, signer_id: SIGNER } }] }; },
    status: async (hash, signer) => { calls.push(`status:${hash}:${signer}`); return status; },
    height: async blockHash => { calls.push(`height:${blockHash}`); return 123n; },
  };
}

test("proves an exact NEP-141 transfer only from the named final transaction and receipt", async () => {
  const io = reads();
  assert.deepEqual(await verifyFundingReceipt({ destinationTxHash: HASH, recipient: ACCOUNT, asset: ASSETS.USDC, amount: "500000" }, io),
    { destinationTxHash: HASH, blockHeight: "123", recipient: ACCOUNT, asset: ASSETS.USDC, amount: "500000" });
  assert.deepEqual(io.calls, [`index:${HASH}`, `status:${HASH}:${SIGNER}`, `height:${BLOCK}`]);
});

test("proves an account-opening native transfer from its successful final receipt", async () => {
  const io = reads(fixture([native]));
  assert.deepEqual(await verifyFundingReceipt({ destinationTxHash: HASH, recipient: ACCOUNT, asset: ASSETS.wNEAR,
    amount: "20000000000000000000000" }, io),
  { destinationTxHash: HASH, blockHeight: "123", recipient: ACCOUNT, asset: ASSETS.wNEAR, amount: "20000000000000000000000" });
});

test("hashless, malformed and unsupported proofs never clear funding", async () => {
  for (const input of [
    { destinationTxHash: null, recipient: ACCOUNT, asset: ASSETS.USDC, amount: "500000" },
    { destinationTxHash: "not-a-near-hash", recipient: ACCOUNT, asset: ASSETS.USDC, amount: "500000" },
    { destinationTxHash: HASH, recipient: ACCOUNT, asset: ASSETS.USDC, amount: "0" },
    { destinationTxHash: HASH, recipient: ACCOUNT, asset: "nep141:other.near", amount: "500000" },
  ]) {
    const io = reads();
    assert.equal(await verifyFundingReceipt(input, io), null);
    assert.deepEqual(io.calls, []);
  }
});

test("a stale or mismatched transaction cannot prove the withdrawal", async () => {
  for (const status of [
    fixture([token], { status: { final_execution_status: "EXECUTED" } }),
    fixture([token], { status: { status: { Failure: {} } } }),
    fixture([token], { transaction: { hash: "other" } }),
    fixture([token], { transaction: { signer_id: "other.near" } }),
    fixture([token], { status: { receipts_outcome: [] } }),
    fixture([token], { status: { receipts_outcome: [
      { id: "r-token", block_hash: BLOCK, outcome: { status: { SuccessValue: "" }, logs: [transfer()] } },
      { id: "unaccounted", block_hash: BLOCK, outcome: { status: { SuccessValue: "" }, logs: [] } },
    ] } }),
  ]) assert.equal(await verifyFundingReceipt({ destinationTxHash: HASH, recipient: ACCOUNT, asset: ASSETS.USDC,
    amount: "500000" }, reads(status)), null);
});

test("recipient, asset and delivered amount must each match, including all credits in one transaction", async () => {
  for (const credits of [
    [receipt("wrong-key", USDC, [], [transfer("500000", "other.near")])],
    [receipt("wrong-token", "other.near", [], [transfer()])],
    [receipt("wrong-amount", USDC, token.receipt.Action.actions, [transfer("499999")])],
    [token, receipt("extra", USDC, [], [transfer("1")])],
    [receipt("bad-log", USDC, token.receipt.Action.actions, [transfer(), "EVENT_JSON:not-json"])],
    [receipt("transfer-call", USDC, [{ FunctionCall: { method_name: "ft_transfer_call",
      args: Buffer.from(JSON.stringify({ receiver_id: ACCOUNT, amount: "500000" })).toString("base64") } }], [transfer()])],
  ]) assert.equal(await verifyFundingReceipt({ destinationTxHash: HASH, recipient: ACCOUNT, asset: ASSETS.USDC,
    amount: "500000" }, reads(fixture(credits))), null);
});

test("native receipt amount and success are required", async () => {
  const input = { destinationTxHash: HASH, recipient: ACCOUNT, asset: ASSETS.wNEAR, amount: "20000000000000000000000" };
  assert.equal(await verifyFundingReceipt(input, reads(fixture([receipt("small", ACCOUNT,
    [{ Transfer: { deposit: "19999999999999999999999" } }])]))), null);
  const failed = fixture([native]);
  failed.receipts_outcome[0]!.outcome.status = { Failure: {} } as never;
  assert.equal(await verifyFundingReceipt(input, reads(failed)), null);
});

test("an indexer omission or ambiguous duplicate signer never produces proof", async () => {
  const input = { destinationTxHash: HASH, recipient: ACCOUNT, asset: ASSETS.USDC, amount: "500000" };
  const omitted = reads(); omitted.transactions = async () => ({ transactions: [] });
  assert.equal(await verifyFundingReceipt(input, omitted), null);
  const duplicate = reads(); duplicate.transactions = async () => ({ transactions: [
    { transaction: { hash: HASH, signer_id: SIGNER } }, { transaction: { hash: HASH, signer_id: SIGNER } },
  ] });
  assert.equal(await verifyFundingReceipt(input, duplicate), null);
});

test("unavailable index, final status or receipt block leaves the funding reservation intact", async () => {
  const input = { destinationTxHash: HASH, recipient: ACCOUNT, asset: ASSETS.USDC, amount: "500000" };
  for (const fail of ["transactions", "status", "height"] as const) {
    const io = reads();
    io[fail] = (async () => { throw new Error("private transport detail"); }) as never;
    assert.equal(await verifyFundingReceipt(input, io), null);
  }
});
