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

test("only confidential USDC is paid yet: another asset is refused by authorize, a chain delivery before anything is recorded", async () => {
  const other = await requestPayout(APP, { ...request("r-1"), asset: "nep141:wrap.near" });
  assert.deepEqual([other.state, other.code], ["refused", "transfer_not_allowed"]);
  await assert.rejects(requestPayout(APP, { ...request("r-2"), delivery: { chain: "near" } }), PublicError);
  assert.equal((await payoutStatus(APP, "r-2")).state, "not_found");
  assert.equal(sends.length, 0);
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
