import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { api } from "../src/api.js";
import { ledger } from "../src/ledger.js";
import { freshDirectory, offline } from "./fixtures/harness.js";

freshDirectory("ledger");
const deposit = (id = "fixture", hash = "tx", address = "deposit.near", at = "2026-01-01T00:00:00Z") => ({
  type: "deposit", status: "SUCCESS", correlation_id: id, created_at: at, updated_at: at,
  details: { deposit_tx_hash: hash, deposit_address: address },
});
const transfer = (address = "deposit.near") => `EVENT_JSON:${JSON.stringify({ standard: "nep141", event: "ft_transfer",
  data: [{ new_owner_id: address }] })}`;
const receipt = (asset = "token.near", logs = [transfer()]) => ({ receipt: { receiver_id: asset }, execution_outcome: { outcome: { logs } } });
const response = (...receipts: unknown[]) => ({ transactions: [{ receipts }] });
const call = (method: string, args: object) => ({ FunctionCall: { method_name: method, args: Buffer.from(JSON.stringify(args)).toString("base64"), gas: 30_000_000_000_000, deposit: "1" } });
/** A receipt as FastNear returns it for a call to a token contract that logs no NEP-141 event, as wrap.near doesn't. */
const callReceipt = (asset: string, actions: unknown[], status: object = { SuccessValue: "" }, logs: string[] = []) =>
  ({ receipt: { receiver_id: asset, receipt: { Action: { actions } } }, execution_outcome: { outcome: { logs, status } } });
/** Observed on mainnet, 2026-11-06: a wallet wraps NEAR and sends the wNEAR to the deposit address in one receipt. */
const wrapAndSend = (to = "deposit.near", amount = "3000", status?: object) => callReceipt("wrap.near", [
  call("storage_deposit", { account_id: to, registration_only: true }), call("near_deposit", {}), call("ft_transfer", { amount, receiver_id: to })],
  status, [`Deposit ${amount} NEAR to wallet.near`, `Transfer ${amount} from wallet.near to ${to}`]);
const wnearDeposit = (request: object = { origin_asset: "nep141:wrap.near", confidential: true }) => ({
  ...deposit(), details: { deposit_tx_hash: "tx", deposit_address: "deposit.near", deposited_amount: "3000", amount_out: "3000", confidential: true, request } });
beforeEach(() => {
  offline();
  mock.method(api, "getHistory", async () => ({ data: [deposit()] }));
  mock.method(api, "listProviderRecords", async () => ({ data: { events: [] } }));
});
afterEach(() => mock.restoreAll());

test("valid deposit evidence identifies the asset and unmatched evidence stays null", async () => {
  for (const [body, asset] of [[response(receipt()), "nep141:token.near"], [response(receipt("token.near", [transfer("other.near")])), null],
    [response(receipt("token.near", ["ordinary log", 'EVENT_JSON:{"standard":"other","event":"other"}'])), null],
    [{ transactions: [] }, null]]) {
    mock.method(globalThis, "fetch", async () => Response.json(body));
    const [row] = await ledger();
    assert.equal(row?.assetIn, asset);
    assert.equal(row?.assetOut, asset);
  }
});

test("a successful ft_transfer call to the deposit address identifies the asset when the token logs no event", async () => {
  mock.method(api, "getHistory", async () => ({ data: [wnearDeposit()] }));
  mock.method(globalThis, "fetch", async () => Response.json(response(wrapAndSend())));
  const [row] = await ledger();
  assert.equal(row?.assetIn, "nep141:wrap.near");
  assert.equal(row?.assetOut, "nep141:wrap.near");
});

test("an ft_transfer call proves a deposit only when it succeeded, paid the deposit address the deposited amount, and agrees with the API's request", async () => {
  for (const [label, history, body] of [
    ["failed receipt", wnearDeposit(), response(wrapAndSend("deposit.near", "3000", { Failure: {} }))],
    ["another receiver", wnearDeposit(), response(wrapAndSend("other.near"))],
    ["another amount", wnearDeposit(), response(wrapAndSend("deposit.near", "2999"))],
    ["ft_transfer_call, which the receiver can refund", wnearDeposit(), response(callReceipt("wrap.near", [call("ft_transfer_call", { amount: "3000", receiver_id: "deposit.near", msg: "" })]))],
    ["the API names another asset", wnearDeposit({ origin_asset: "nep141:usdt.tether-token.near" }), response(wrapAndSend())],
  ] as const) {
    mock.method(api, "getHistory", async () => ({ data: [history] }));
    mock.method(globalThis, "fetch", async () => Response.json(body));
    const [row] = await ledger();
    assert.equal(row?.assetIn, null, label);
  }
});

test("an event's asset must agree with the API's request too", async () => {
  mock.method(api, "getHistory", async () => ({ data: [{ ...deposit(), details: { ...deposit().details, request: { origin_asset: "nep141:other.near" } } }] }));
  mock.method(globalThis, "fetch", async () => Response.json(response(receipt())));
  assert.equal((await ledger())[0]?.assetIn, null);
});

test("invalid deposit evidence fails explicitly without leaking response contents", async () => {
  const invalid = [
    {}, { transactions: null }, { transactions: [{}] }, response(null), response({}),
    response({ execution_outcome: { outcome: { logs: [transfer()] } } }),
    response(receipt("", [transfer()])), response(receipt("   ", [transfer()])),
    response({ receipt: { receiver_id: 42 }, execution_outcome: { outcome: { logs: [transfer()] } } }),
    response({ receipt: { receiver_id: "token.near" }, execution_outcome: { outcome: { logs: [42] } } }),
    response(receipt("token.near", ["EVENT_JSON:private-malformed"])),
    response(receipt("token.near", ["EVENT_JSON:null"])),
    response(receipt("token.near", ['EVENT_JSON:{"standard":"nep141","event":"ft_transfer"}'])),
    response(receipt("token.near", ['EVENT_JSON:{"standard":"nep141","event":"ft_transfer","data":[]}'])),
    response(receipt("token.near", ['EVENT_JSON:{"standard":"nep141","event":"ft_transfer","data":{}}'])),
    response(receipt("token.near", ['EVENT_JSON:{"standard":"nep141","event":"ft_transfer","data":[{}]}'])),
    response(receipt(), receipt("token.near", ["EVENT_JSON:private-malformed"])),
    response(callReceipt("wrap.near", [{ FunctionCall: { method_name: "ft_transfer", args: "private-malformed" } }])),
    response(callReceipt("wrap.near", [call("ft_transfer", { amount: 3000, receiver_id: "deposit.near" })])),
  ];
  for (const body of invalid) {
    mock.method(globalThis, "fetch", async () => Response.json(body));
    await assert.rejects(ledger(), error => error instanceof Error && /deposit evidence.*unavailable/i.test(error.message)
      && !error.message.includes("private-malformed"), JSON.stringify(body));
  }
});

test("lookups deduplicate hashes, retain address identity and order, and use at most four workers", async () => {
  const rows = [deposit("later", "shared", "second.near", "2026-02-01T00:00:00Z"), deposit("first", "shared"),
    ...Array.from({ length: 8 }, (_, i) => deposit(`row${i}`, `tx${i}`))];
  mock.method(api, "getHistory", async () => ({ data: rows }));
  let active = 0, peak = 0;
  const hashes: string[] = [];
  mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const { tx_hashes } = JSON.parse(String(init?.body));
    assert.equal(tx_hashes.length, 1);
    hashes.push(tx_hashes[0]);
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return Response.json(response(receipt(), receipt("second-token.near", [transfer("second.near")])));
  });
  const result = await ledger();
  assert.equal(peak, 4);
  assert.equal(hashes.length, 9);
  assert.equal(new Set(hashes).size, 9);
  assert.equal(result[0]?.correlationId, "first");
  assert.equal(result[0]?.assetIn, "nep141:token.near");
  assert.equal(result.at(-1)?.correlationId, "later");
  assert.equal(result.at(-1)?.assetIn, "nep141:second-token.near");
  await ledger();
  assert.equal(hashes.length, 18, "cache is confined to one invocation");
});

test("failed lookups reject the ledger and leave no workers running after rejection", async () => {
  mock.method(api, "getHistory", async () => ({ data: Array.from({ length: 8 }, (_, i) => deposit(`row${i}`, `tx${i}`)) }));
  let active = 0;
  const fetch = mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    active++;
    try {
      if (String(init?.body).includes('"tx0"')) throw new Error("private transport details");
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(new Error("read aborted"));
        init?.signal?.addEventListener("abort", aborted, { once: true });
        setImmediate(() => { init?.signal?.removeEventListener("abort", aborted); resolve(); });
      });
      return Response.json(response(receipt()));
    } finally { active--; }
  });
  await assert.rejects(ledger(), /unavailable/i);
  assert.equal(active, 0);
  assert.equal(fetch.mock.callCount(), 4, "no queued lookups start after the failure");
});

test("only successful deposits with transaction and address evidence trigger lookups", async () => {
  mock.method(api, "getHistory", async () => ({ data: [
    { ...deposit(), type: "swap" }, { ...deposit(), status: "FAILED" },
    { ...deposit(), details: { deposit_tx_hash: "tx" } },
    { ...deposit(), details: { deposit_address: "deposit.near" } },
  ] }));
  const fetch = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected lookup"); });
  assert.equal((await ledger()).length, 4);
  assert.equal(fetch.mock.callCount(), 0);
});

test("ledger cancellation aborts active receipt requests and leaves queued hashes unread", { timeout: 2000 }, async () => {
  mock.method(api, "getHistory", async () => ({ data: Array.from({ length: 12 }, (_, i) => deposit(`row${i}`, `tx${i}`)) }));
  let started!: () => void, calls = 0, aborted = 0;
  const ready = new Promise<void>(resolve => { started = resolve; });
  mock.method(globalThis, "fetch", (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    calls++;
    init?.signal?.addEventListener("abort", () => { aborted++; reject(new Error("cancelled")); }, { once: true });
    if (calls === 4) started();
  }));
  const controller = new AbortController();
  const rejected = assert.rejects(ledger("fixture", controller.signal), /read cancelled/);
  await ready; controller.abort(); await rejected;
  assert.equal(calls, 4); assert.equal(aborted, 4);
});

test("reconciliation includes receipt-backed incoming funds and retains positive coverage gaps separately from shortfalls", async () => {
  const { reconcileBooks } = await import("../src/ledger.js");
  const { recordIncomingCredit } = await import("../src/incoming-credits.js");
  const id = process.env.AGENT_ID!;
  mock.method(api, "getHistory", async () => ({ data: [] }));
  mock.method(api, "getAgent", async () => ({ wallet: { near_account_id: "wallet.near" } }));
  mock.method(api, "getTokens", async () => [{ asset_id: "nep141:usdc", symbol: "USDC" }]);
  let balance = "10000000";
  mock.method(api, "getBalances", async (_id: string, query?: { source?: string }) => ({ balances: query?.source === "confidential" ? [{ asset_id: "nep141:usdc", balance_raw: balance }] : [] }));
  mock.method(globalThis, "fetch", async () => Response.json({ transfers: [] }));
  const before = (await reconcileBooks())[0]!;
  assert.equal(before.confidential.status, "history-incomplete");
  recordIncomingCredit({ agent: id, recipient: "wallet.near", asset: "nep141:usdc", amount: "10000000", settledAt: "2026-01-01T00:00:00Z", source: { issuer: "https://receipt.example", receiptId: "credit-1" }, recordedBy: "fixture operator", recordedAt: "2026-01-02T00:00:00Z", evidence: "operator-receipt" }, Buffer.from("synthetic funding receipt"));
  const credited = (await reconcileBooks())[0]!;
  assert.equal(credited.confidential.recorded, "10000000");
  assert.equal(credited.confidential.incomingRecorded, "10000000");
  assert.equal(credited.confidential.status, "matched");
  assert.equal(credited.confidential.unattributed, "0");
  assert.equal(credited.confidential.credits[0]?.evidence, "operator-receipt");
  balance = "0";
  const shortfall = (await reconcileBooks())[0]!;
  assert.equal(shortfall.confidential.status, "balance-mismatch");
  assert.equal(shortfall.confidential.unattributed, "-10000000");
});
