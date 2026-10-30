import { authorityFixture, policyView } from "./fixtures/authority.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { AgentApiError, type Policy } from "@near-intents-agent-api/sdk";
import { ORPCError } from "@orpc/server";
import { api } from "../src/api.js";
import { acquireMoneyLock, MoneyLockBusy, UnresolvedOperations } from "../src/lock.js";
import { mandateDigest } from "../src/mandate.js";
import { opsLog, readOps, record } from "../src/ops.js";
import { readFileSync } from "node:fs";
import { payoutStatus, requestKey, requestPayout } from "../src/payout-requests.js";
import { payoutRequestInput } from "../src/contract/inputs.js";
import { ASSETS, payoutPolicy } from "../src/policy.js";
import { PublicError } from "../src/public-error.js";
import { freshDirectory, offline } from "./fixtures/harness.js";

/** Payout requests through the real money path: the journal, the money lock, `authorize` and the one send site. */

const APP = "app:staging:org_1";
let policy: Policy;
let sends: { key: string; recipient: string }[];
let transfer: (key: string, request: { recipient: string }) => Promise<{ correlation_id: string }>;
let status: string;

freshDirectory("payout-requests");
beforeEach(() => {
  process.env.AGENT_GRANT_TOKEN = "ngt_fixture";
  policy = payoutPolicy(["payee.near", "other.near"]);
  sends = [];
  status = "SUCCESS";
  transfer = async (key, request) => { sends.push({ key, recipient: request.recipient }); return { correlation_id: `op_${sends.length}` }; };
  offline();
  for (const [name, method] of Object.entries(authorityFixture())) mock.method(api, name as keyof typeof api, method as never);
  mock.method(api, "getPolicy", async () => policyView(policy));
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, status }));
  const send = (_id: string, request: { recipient: string }, { idempotencyKey }: { idempotencyKey: string }) => transfer(idempotencyKey, request);
  mock.method(api, "forGrant", () => ({ transfer: send, swap: send, shield: send, unshield: send }));
});
afterEach(() => mock.restoreAll());

const reviewed = () => ({ revision: 1, digest: mandateDigest(policy) });
const request = (requestId: string, recipient = "payee.near", amount = "1000000") =>
  ({ requestId, asset: ASSETS.USDC, delivery: "intents" as const, recipient, amount, expectedPolicy: reviewed() });

test("a request is sent once under a key derived from its caller and requestId; asking again sends nothing", async () => {
  const first = await requestPayout(APP, request("r-1"));
  assert.deepEqual(first, { requestId: "r-1", state: "succeeded", status: "SUCCESS", correlationId: "op_1", code: null });
  assert.deepEqual(sends, [{ key: requestKey(APP, "r-1"), recipient: "payee.near" }], "the provider's idempotency key is the request's identity");
  assert.deepEqual(await requestPayout(APP, request("r-1")), first);
  assert.deepEqual(await payoutStatus(APP, "r-1"), first);
  assert.equal(sends.length, 1);
  assert.equal(readOps().filter(op => op.idempotencyKey === requestKey(APP, "r-1")).length, 1);
});

test("the same requestId with other terms is refused before anything is sent", async () => {
  await requestPayout(APP, request("r-1"));
  for (const changed of [request("r-1", "other.near"), request("r-1", "payee.near", "2000000")])
    await assert.rejects(requestPayout(APP, changed), (error: unknown) =>
      error instanceof ORPCError && error.code === "CONFLICT" && (error.data as { code?: string }).code === "request_conflict");
  assert.equal(sends.length, 1);
});

test("two callers' requests never share an identity, even under the same requestId", async () => {
  await requestPayout(APP, request("r-1"));
  await requestPayout("app:staging:org_2", request("r-1"));
  await requestPayout("owner.near", request("r-1"));
  assert.equal(new Set(sends.map(s => s.key)).size, 3);
  assert.equal((await payoutStatus("app:staging:org_2", "r-2")).state, "not_found");
});

test("a lost send stays unknown: never sent again, it blocks other requests until its outcome is proven", async () => {
  transfer = async (key, request) => { sends.push({ key, recipient: request.recipient }); throw new Error("socket hang up"); };
  assert.deepEqual(await requestPayout(APP, request("r-1")), { requestId: "r-1", state: "unknown", status: null, correlationId: null, code: null });
  assert.deepEqual((await requestPayout(APP, request("r-1"))).state, "unknown");
  assert.deepEqual((await payoutStatus(APP, "r-1")).state, "unknown");
  assert.equal(sends.length, 1, "a lost request is never resent");
  await assert.rejects(requestPayout(APP, request("r-2")), UnresolvedOperations);
  assert.equal(sends.length, 1);
});

test("a refusal is recorded before anything is sent; a new attempt is a new requestId", async () => {
  mock.method(api, "getBalances", async () => ({ balances: [] }));
  const refused = await requestPayout(APP, request("r-1"));
  assert.deepEqual([refused.state, refused.code], ["refused", "insufficient_balance"]);
  assert.deepEqual(await requestPayout(APP, request("r-1")), refused, "the same request stays refused");
  assert.equal(sends.length, 0);
  mock.restoreAll();
  offline();
  for (const [name, method] of Object.entries(authorityFixture())) mock.method(api, name as keyof typeof api, method as never);
  mock.method(api, "getPolicy", async () => policyView(policy));
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, status }));
  const send = (_id: string, r: { recipient: string }, { idempotencyKey }: { idempotencyKey: string }) => transfer(idempotencyKey, r);
  mock.method(api, "forGrant", () => ({ transfer: send, swap: send, shield: send, unshield: send }));
  assert.equal((await requestPayout(APP, request("r-2"))).state, "succeeded");
  assert.equal(sends.length, 1);
});

test("a provider's proven refusal is recorded as refused, with its code", async () => {
  transfer = async (key, request) => {
    sends.push({ key, recipient: request.recipient });
    throw new AgentApiError(403, { errors: [{ status: "403", code: "policy_denied", layer: "request", title: "policy_denied", meta: { retryable: false } }], meta: {} });
  };
  const refused = await requestPayout(APP, request("r-1"));
  assert.deepEqual([refused.state, refused.code], ["refused", "policy_denied"]);
  assert.equal(sends.length, 1);
  assert.equal((await requestPayout(APP, request("r-2"))).state, "refused", "a proven refusal blocks nothing");
});

test("a payout held for the owner's approval reads as held, then as settled once the provider says so", async () => {
  status = "PENDING_APPROVAL";
  assert.equal((await requestPayout(APP, request("r-1"))).state, "held");
  status = "SUCCESS";
  assert.deepEqual(await payoutStatus(APP, "r-1"), { requestId: "r-1", state: "succeeded", status: "SUCCESS", correlationId: "op_1", code: null });
  assert.equal(sends.length, 1);
});

test("a request that never reached the send site is not recorded, so its status is not_found and asking again may send", async () => {
  mock.method(api, "getPolicy", async () => { throw new Error("provider unreachable"); });
  await assert.rejects(requestPayout(APP, request("r-1")), /provider unreachable/);
  assert.equal((await payoutStatus(APP, "r-1")).state, "not_found");
  mock.method(api, "getPolicy", async () => policyView(policy));
  assert.equal((await requestPayout(APP, request("r-1"))).state, "succeeded");
  assert.equal(sends.length, 1);
});

test("concurrent requests under one requestId send once", async () => {
  const results = await Promise.allSettled([requestPayout(APP, request("r-1")), requestPayout(APP, request("r-1")), requestPayout(APP, request("r-1"))]);
  assert.equal(sends.length, 1);
  for (const result of results)
    assert.ok(result.status === "fulfilled" ? result.value.state === "succeeded" : result.reason instanceof MoneyLockBusy, String(result.status === "rejected" && result.reason));
});

test("asking again answers from the journal alone: no provider read, no money lock", async () => {
  const first = await requestPayout(APP, request("r-1"));
  const reads = mock.method(api, "getPolicy", async () => policyView(policy));
  assert.deepEqual(await requestPayout(APP, request("r-1")), first);
  assert.equal(reads.mock.callCount(), 0, "a repeat reads nothing from the provider");
  const lock = await acquireMoneyLock();
  try {
    assert.deepEqual(await requestPayout(APP, request("r-1")), first, "nor waits for the lock");
    await assert.rejects(requestPayout(APP, request("r-2")), MoneyLockBusy, "a new request still waits for the lock");
  } finally { await lock.release(); }
  assert.equal(sends.length, 1);
});

test("a request without the caller's identity is refused and records nothing", async () => {
  await assert.rejects(requestPayout(undefined, request("r-1")), PublicError);
  await assert.rejects(payoutStatus(undefined, "r-1"), PublicError);
  assert.equal(readOps().length, 0);
  assert.equal(sends.length, 0);
});

test("a request is judged as a payout or not at all: under a grant for other work it is refused before sending", async () => {
  for (const [name, method] of Object.entries(authorityFixture("treasury"))) mock.method(api, name as keyof typeof api, method as never);
  const refused = await requestPayout(APP, request("r-1"));
  assert.deepEqual([refused.state, refused.code], ["refused", "grant_purpose_denied"]);
  assert.equal(sends.length, 0);
});

test("an approve-only copy answers no request: the executor's journal holds them", async () => {
  await requestPayout(APP, request("r-1"));
  process.env.EXECUTOR = "off";
  try { await assert.rejects(payoutStatus(APP, "r-1"), PublicError); }
  finally { delete process.env.EXECUTOR; }
});

test("a payout that failed or was refunded at the provider reads as failed, never as succeeded", async () => {
  for (const [final, state] of [["SUCCESS", "succeeded"], ["FAILED", "failed"], ["REFUNDED", "failed"]] as const) {
    status = final;
    const answer = await requestPayout(APP, request(`r-${final}`, "payee.near", String(1000 + final.length)));
    assert.deepEqual([answer.state, answer.status], [state, final]);
  }
});

test("a request recorded by another caller between the early answer and the write-ahead record is not recorded or sent again", async () => {
  const key = requestKey(APP, "r-1"), terms = { recipient: "payee.near", asset: ASSETS.USDC, amount: "1000000", confidential: true };
  mock.method(api, "getPolicy", async () => {
    // Another process recorded and claimed this request after this call's early check.
    if (!readOps().some(op => op.idempotencyKey === key)) {
      record({ at: new Date().toISOString(), idempotencyKey: key, kind: "payout", journalVersion: 2, method: "transfer", request: terms });
      record({ idempotencyKey: key, submissionState: "SUBMISSION_ATTEMPTED" });
      // Held for the owner: it doesn't block sends, so only the journal's refusal of a second preparation stops this one.
      record({ idempotencyKey: key, correlation_id: "op_other", status: "PENDING_APPROVAL" });
    }
    return policyView(policy);
  });
  assert.equal((await requestPayout(APP, request("r-1"))).state, "held");
  assert.equal(sends.length, 0);
  assert.equal(readOps().filter(op => op.idempotencyKey === key).length, 1);
});

test("through intents only confidential USDC is paid; a withdrawal goes only to chain near, other chains refused before anything is recorded", async () => {
  const other = await requestPayout(APP, { ...request("r-1"), asset: ASSETS.wNEAR });
  assert.deepEqual([other.state, other.code], ["refused", "transfer_not_allowed"]);
  await assert.rejects(requestPayout(APP, { ...request("r-2"), delivery: { chain: "eth" } }), (error: unknown) =>
    error instanceof ORPCError && (error.data as { code?: string }).code === "chain_not_supported");
  assert.equal((await payoutStatus(APP, "r-2")).state, "not_found");
  assert.equal(sends.length, 0);
});

/** A payout policy that also withdraws, to `payee.near`, wNEAR and USDC. */
const withdrawing = (): Policy => {
  const base = payoutPolicy(["payee.near"]);
  // Auto-pay, so the provider settles without a vote (a held withdrawal can only be rejected for now).
  return { ...base, owner_approval: false, actions: ["transfer", "withdraw"], assets: [ASSETS.USDC, ASSETS.wNEAR],
    destinations: { mode: "only", list: [...base.destinations.list, { action: "withdraw", chain: "near", address: "payee.near", memo: null }] } };
};
const withdrawal = (requestId: string, asset: string = ASSETS.wNEAR, recipient = "payee.near", amount = "1000000") =>
  ({ requestId, asset, delivery: { chain: "near" }, recipient, amount, expectedPolicy: reviewed() });

test("a withdrawal to an agreed NEAR account is sent once, from the confidential balance, through the one send site", async () => {
  policy = withdrawing();
  const sent: unknown[] = [];
  const withdraw = async (_id: string, body: unknown, { idempotencyKey }: { idempotencyKey: string }) => { sent.push({ idempotencyKey, body }); return { correlation_id: `op_w${sent.length}` }; };
  mock.method(api, "forGrant", () => ({ withdraw, transfer: assert.fail, swap: assert.fail, shield: assert.fail, unshield: assert.fail }));
  mock.method(api, "getBalances", async (_id: string, { source }: { source: string }) => ({ near_account_id: "w", source,
    balances: [{ asset_id: ASSETS.wNEAR, balance_raw: "5000000" }, { asset_id: ASSETS.USDC, balance_raw: "5000000" }] }));
  for (const [id, asset] of [["w-near", ASSETS.wNEAR], ["w-usdc", ASSETS.USDC]] as const) {
    const first = await requestPayout(APP, withdrawal(id, asset));
    assert.deepEqual([first.state, first.code], ["succeeded", null], id);
    assert.deepEqual(await requestPayout(APP, withdrawal(id, asset)), first, "asking again sends nothing");
  }
  assert.deepEqual(sent, [
    { idempotencyKey: requestKey(APP, "w-near"), body: { asset: ASSETS.wNEAR, amount: "1000000", chain: "near", recipient: "payee.near", confidential: true } },
    { idempotencyKey: requestKey(APP, "w-usdc"), body: { asset: ASSETS.USDC, amount: "1000000", chain: "near", recipient: "payee.near", confidential: true } },
  ]);
  assert.deepEqual(readOps().filter(op => op.idempotencyKey.startsWith("request:")).map(op => op.method), ["withdraw", "withdraw"], "the journal records the method");
  await assert.rejects(requestPayout(APP, { ...withdrawal("w-near"), delivery: "intents" }), (error: unknown) =>
    error instanceof ORPCError && (error.data as { code?: string }).code === "request_conflict", "the same requestId can't switch to a transfer");
});

test("a withdrawal is refused unless its payee is an agreed withdrawal account, its asset wNEAR or USDC, and the balance covers it", async () => {
  policy = withdrawing();
  mock.method(api, "forGrant", () => ({ withdraw: assert.fail, transfer: assert.fail, swap: assert.fail, shield: assert.fail, unshield: assert.fail }));
  mock.method(api, "getBalances", async (_id: string, { source }: { source: string }) => ({ near_account_id: "w", source,
    balances: [{ asset_id: ASSETS.wNEAR, balance_raw: "5000000" }] }));
  const refused = async (input: ReturnType<typeof withdrawal>) => { const r = await requestPayout(APP, input); return [r.state, r.code]; };
  assert.deepEqual(await refused(withdrawal("a", ASSETS.wNEAR, "other.near")), ["refused", "payee_not_agreed"], "a transfer payee is not a withdrawal payee");
  policy = { ...withdrawing(), destinations: { mode: "only", list: [{ action: "transfer", address: "payee.near", confidential: true }] } };
  assert.deepEqual(await refused(withdrawal("b")), ["refused", "payee_not_agreed"], "an agreed transfer payee isn't agreed for withdrawals");
  policy = withdrawing();
  assert.deepEqual(await refused(withdrawal("c", "nep141:other.near")), ["refused", "withdraw_not_allowed"]);
  assert.deepEqual(await refused(withdrawal("d", ASSETS.wNEAR, "payee.near", "6000000")), ["refused", "insufficient_balance"]);
  assert.deepEqual(await refused(withdrawal("e", ASSETS.USDC)), ["refused", "insufficient_balance"], "the balance is per asset");
});

test("a withdrawal to a named account that doesn't exist on NEAR is refused before anything is recorded or sent", async () => {
  policy = { ...withdrawing(), destinations: { mode: "only", list: [{ action: "withdraw", chain: "near", address: "ghost.near", memo: null }] } };
  mock.method(api, "forGrant", () => ({ withdraw: assert.fail, transfer: assert.fail, swap: assert.fail, shield: assert.fail, unshield: assert.fail }));
  const { recipientChain } = await import("../src/recipients.js");
  mock.method(recipientChain, "exists", async () => false);
  await assert.rejects(requestPayout(APP, withdrawal("g-1", ASSETS.USDC, "ghost.near")), (error: unknown) =>
    error instanceof ORPCError && (error.data as { code?: string }).code === "recipient_not_found");
  assert.equal((await payoutStatus(APP, "g-1")).state, "not_found");
});

test("a USDC withdrawal to an account not registered on the USDC contract is refused before anything is recorded; wNEAR needs no registration", async () => {
  policy = withdrawing();
  const sent: unknown[] = [];
  const send = async () => { sent.push(1); return { correlation_id: `op_r${sent.length}` }; };
  mock.method(api, "forGrant", () => ({ withdraw: send, transfer: send, swap: assert.fail, shield: assert.fail, unshield: assert.fail }));
  mock.method(api, "getBalances", async (_id: string, { source }: { source: string }) => ({ near_account_id: "w", source,
    balances: [{ asset_id: ASSETS.wNEAR, balance_raw: "5000000" }, { asset_id: ASSETS.USDC, balance_raw: "5000000" }] }));
  const { recipientChain } = await import("../src/recipients.js");
  const read = mock.method(recipientChain, "registered", async () => false);
  await assert.rejects(requestPayout(APP, withdrawal("u-1", ASSETS.USDC)), (error: unknown) =>
    error instanceof ORPCError && (error.data as { kind?: string; code?: string }).kind === "refused" && (error.data as { code?: string }).code === "recipient_not_registered");
  assert.deepEqual(read.mock.calls.map(call => call.arguments), [[ASSETS.USDC.replace(/^nep141:/, ""), "payee.near"]], "read on the token's own contract");
  assert.equal((await payoutStatus(APP, "u-1")).state, "not_found", "nothing recorded, so the requestId is kept");
  assert.equal((await requestPayout(APP, withdrawal("n-1", ASSETS.wNEAR))).state, "succeeded", "wNEAR arrives as native NEAR");
  assert.equal(read.mock.callCount(), 1, "no registration read for wNEAR");
  assert.equal((await requestPayout(APP, request("t-1"))).state, "succeeded", "a transfer stays inside NEAR Intents");
  assert.equal(read.mock.callCount(), 1, "no registration read for a transfer");
  read.mock.mockImplementation(async () => { throw new Error("rpc down"); });
  await assert.rejects(requestPayout(APP, withdrawal("u-2", ASSETS.USDC)), (error: unknown) =>
    error instanceof ORPCError && (error.data as { code?: string }).code === "recipient_unchecked");
  read.mock.mockImplementation(async () => true);
  assert.equal((await requestPayout(APP, withdrawal("u-1", ASSETS.USDC))).state, "succeeded", "once registered, the same requestId is sent once");
  assert.equal(sent.length, 3, "wNEAR, the transfer, and u-1 once registered");
});

test("a withdrawal's recipient must be a NEAR account: a nearcom: address is refused by the request's schema", () => {
  const parse = (recipient: string, delivery: "intents" | { chain: string }) =>
    payoutRequestInput.safeParse({ requestId: "r", asset: ASSETS.wNEAR, delivery, recipient, amount: "1", expectedPolicy: reviewed() });
  assert.equal(parse("nearcom:0xabc0000000000000000000000000000000000000", { chain: "near" }).success, false);
  const viaIntents = parse("nearcom:0xABC0000000000000000000000000000000000000", "intents");
  assert.equal(viaIntents.success && viaIntents.data.recipient, "0xabc0000000000000000000000000000000000000", "through intents it is the bare account");
  assert.equal(parse("payee.near", { chain: "near" }).success, true);
});

test("reading a request that hasn't moved writes nothing to the journal", async () => {
  status = "PENDING_APPROVAL";
  await requestPayout(APP, request("r-1"));
  const lines = () => readFileSync(opsLog(), "utf8").trim().split("\n").length;
  const before = lines();
  for (let i = 0; i < 5; i++) assert.equal((await payoutStatus(APP, "r-1")).state, "held");
  assert.equal(lines(), before, "polling an unchanged request appends nothing");
  status = "SUCCESS";
  assert.equal((await payoutStatus(APP, "r-1")).state, "succeeded");
  assert.equal(lines(), before + 1, "a change is recorded once");
});

test("a payout to a named account that doesn't exist on NEAR is refused before anything is recorded or sent", async () => {
  const { pay } = await import("../src/agent.js");
  const { recipientChain } = await import("../src/recipients.js");
  mock.method(recipientChain, "exists", async (account: string) => account !== "ghost.near");
  const missing = { ...request("r-1"), recipient: "ghost.near" };
  await assert.rejects(requestPayout(APP, missing), (error: unknown) =>
    error instanceof ORPCError && (error.data as { kind?: string; code?: string }).kind === "refused" && (error.data as { code?: string }).code === "recipient_not_found");
  assert.equal((await payoutStatus(APP, "r-1")).state, "not_found", "nothing recorded");
  assert.deepEqual(await pay({ recipient: "ghost.near", asset: ASSETS.USDC, amount: "1", confidential: true }, reviewed()), { outcome: "refused", code: "recipient_not_found" });
  assert.equal(readOps().length, 0);
  assert.equal(sends.length, 0);
});

test("when the chain doesn't answer, the payout is refused unchecked and the same requestId can be asked again", async () => {
  const { recipientChain } = await import("../src/recipients.js");
  const read = mock.method(recipientChain, "exists", async () => { throw new Error("rpc down"); });
  await assert.rejects(requestPayout(APP, request("r-1")), (error: unknown) =>
    error instanceof ORPCError && (error.data as { code?: string }).code === "recipient_unchecked");
  assert.equal(sends.length, 0);
  read.mock.mockImplementation(async () => true);
  assert.equal((await requestPayout(APP, request("r-1"))).state, "succeeded", "nothing was recorded, so the same request is sent once now");
  assert.equal(sends.length, 1);
});

test("implicit accounts need no account on NEAR: no chain read", async () => {
  const { recipientChain } = await import("../src/recipients.js");
  const read = mock.method(recipientChain, "exists", async () => false);
  const implicit = "0x" + "a".repeat(40);
  policy = payoutPolicy(["payee.near", implicit]);
  assert.equal((await requestPayout(APP, { ...request("r-1"), recipient: implicit, expectedPolicy: reviewed() })).state, "succeeded");
  assert.equal(read.mock.callCount(), 0);
});
