import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { beforeEach, mock, test } from "node:test";
import { AgentApiError } from "@near-intents-agent-api/sdk";
import { api } from "../src/api.js";
import { ASSETS } from "../src/policy.js";
import { depositKey, depositStatus, requestDeposit } from "../src/deposit-requests.js";
import { router } from "../src/router.js";
import { call } from "@orpc/server";
import { freshDirectory, offline } from "./fixtures/harness.js";

const APP = "app:paperwork:acme";
const LOG = `.ops/${process.env.AGENT_ID}.deposit-requests.ndjson`;
const lines = () => existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").map(text => JSON.parse(text)) : [];
type Sent = { asset: string; key: string | undefined; recorded: number };
let sent: Sent[];
/** The provider's answer to the next deposit call; a function that throws stands for a refusal or a lost reply. */
let answer: (n: number) => unknown;
const allocation = (n: number) => ({ correlation_id: `op_${n}`, details: { deposit_address: `address-${n}.near`, memo: null, min_amount: "1000", expires_at: "2026-11-19T00:00:00Z" } });

freshDirectory("deposit-requests");
beforeEach(() => {
  mock.restoreAll();
  offline();
  sent = [];
  answer = allocation;
  mock.method(api, "deposit", async (_agent: string, request: { origin_asset: string }, options?: { idempotencyKey?: string }) => {
    // How many lines were on disk when the provider was asked: the request must already be among them.
    sent.push({ asset: request.origin_asset, key: options?.idempotencyKey, recorded: lines().length });
    return answer(sent.length);
  });
});

test("a deposit request is recorded before it is sent, under a key derived from the agent, the caller and its requestId", async () => {
  const first = await requestDeposit(APP, { requestId: "job-1", asset: ASSETS.USDC });
  assert.deepEqual(first, { requestId: "job-1", correlationId: "op_1", address: "address-1.near", memo: null, minAmount: "1000", expiresAt: "2026-11-19T00:00:00Z" });
  assert.deepEqual(sent, [{ asset: ASSETS.USDC, key: depositKey(APP, "job-1"), recorded: 1 }]);
  assert.deepEqual(lines().map(line => line.event), ["requested", "allocated"]);
});

test("asked again, it answers the recorded address and asks the provider nothing", async () => {
  const first = await requestDeposit(APP, { requestId: "job-1", asset: ASSETS.USDC });
  assert.deepEqual(await requestDeposit(APP, { requestId: "job-1", asset: ASSETS.USDC }), first);
  assert.equal(sent.length, 1);
  assert.deepEqual(depositStatus(APP, "job-1"), { requestId: "job-1", state: "ready", asset: ASSETS.USDC, requestedAt: lines()[0].at,
    deposit: { correlationId: "op_1", address: "address-1.near", memo: null, minAmount: "1000", expiresAt: "2026-11-19T00:00:00Z" } });
});

test("a lost reply leaves the request unknown: a repeat refuses and never asks for another address", async () => {
  answer = () => { throw new Error("socket hang up"); };
  await assert.rejects(requestDeposit(APP, { requestId: "job-1", asset: ASSETS.USDC }), /socket hang up/);
  assert.deepEqual(depositStatus(APP, "job-1"), { requestId: "job-1", state: "unknown", asset: ASSETS.USDC, requestedAt: lines()[0].at });
  answer = allocation;
  await assert.rejects(requestDeposit(APP, { requestId: "job-1", asset: ASSETS.USDC }),
    (error: { data?: { code?: string } }) => error.data?.code === "deposit_request_unknown");
  assert.equal(sent.length, 1, "the provider was asked once");
  assert.deepEqual(lines().map(line => line.event), ["requested"]);
});

test("an unrecognized provider error is no proof that nothing was allocated", async () => {
  answer = () => { throw new AgentApiError(500, { errors: [{ status: "500", code: "internal_error", title: "Internal" }] } as never); };
  await assert.rejects(requestDeposit(APP, { requestId: "job-1", asset: ASSETS.USDC }), AgentApiError);
  assert.equal(depositStatus(APP, "job-1").state, "unknown");
});

test("a proven refusal is recorded: nothing was allocated, and the requestId is spent", async () => {
  answer = () => { throw new AgentApiError(403, { errors: [{ status: "403", code: "policy_denied", layer: "request", title: "policy_denied", meta: { retryable: false } }], meta: {} }); };
  await assert.rejects(requestDeposit(APP, { requestId: "job-1", asset: ASSETS.USDC }), AgentApiError);
  assert.deepEqual(depositStatus(APP, "job-1"), { requestId: "job-1", state: "refused", asset: ASSETS.USDC, requestedAt: lines()[0].at, code: "policy_denied" });
  answer = allocation;
  await assert.rejects(requestDeposit(APP, { requestId: "job-1", asset: ASSETS.USDC }),
    (error: { data?: { code?: string } }) => error.data?.code === "deposit_request_refused");
  assert.equal(sent.length, 1);
  assert.equal((await requestDeposit(APP, { requestId: "job-1-retry", asset: ASSETS.USDC })).address, "address-2.near");
});

test("another asset under the same requestId is refused before anything is asked", async () => {
  await requestDeposit(APP, { requestId: "job-1", asset: ASSETS.USDC });
  await assert.rejects(requestDeposit(APP, { requestId: "job-1", asset: ASSETS.wNEAR }),
    (error: { data?: { code?: string } }) => error.data?.code === "request_conflict");
  assert.equal(sent.length, 1);
});

test("concurrent repeats ask the provider once and answer the same address", async () => {
  const answers = await Promise.all([1, 2, 3].map(() => requestDeposit(APP, { requestId: "job-1", asset: ASSETS.USDC })));
  assert.equal(sent.length, 1);
  assert.deepEqual(new Set(answers.map(a => a.address)), new Set(["address-1.near"]));
});

test("each caller's requests are its own", async () => {
  await requestDeposit(APP, { requestId: "job-1", asset: ASSETS.USDC });
  assert.deepEqual(depositStatus("app:other:acme", "job-1"), { requestId: "job-1", state: "not_found" });
  assert.equal((await requestDeposit("app:other:acme", { requestId: "job-1", asset: ASSETS.USDC })).address, "address-2.near");
  assert.notEqual(sent[0]!.key, sent[1]!.key);
});

test("the same caller and requestId on another agent is another provider key", () => {
  const here = depositKey(APP, "job-1"), agent = process.env.AGENT_ID;
  process.env.AGENT_ID = "b".repeat(64);
  try { assert.notEqual(depositKey(APP, "job-1"), here); } finally { process.env.AGENT_ID = agent; }
});

test("a request needs the caller's identity", async () => {
  await assert.rejects(requestDeposit(undefined, { requestId: "job-1", asset: ASSETS.USDC }), /caller's identity/);
  assert.throws(() => depositStatus(undefined, "job-1"), /caller's identity/);
  assert.equal(sent.length, 0);
});

test("a torn line is skipped: a torn answer leaves its request unknown", async () => {
  answer = () => { throw new Error("lost"); };
  await assert.rejects(requestDeposit(APP, { requestId: "job-1", asset: ASSETS.USDC }));
  appendFileSync(LOG, `{"event":"allocated","key":"${depositKey(APP, "job-1")}","at":"2026-11-14T00:00:00Z","deposit":{"correl`);
  assert.equal(depositStatus(APP, "job-1").state, "unknown");
});

test("the deposit route without a requestId allocates each time and records nothing; with one it is the request", async () => {
  const context = { actor: APP };
  assert.equal((await call(router.deposit, undefined, { context }) as { address: string }).address, "address-1.near");
  assert.equal((await call(router.deposit, {}, { context }) as { address: string }).address, "address-2.near");
  assert.equal(existsSync(LOG), false);
  assert.match(sent[0]!.key!, /^[0-9a-f-]{36}$/);
  const requested = await call(router.deposit, { requestId: "job-1" }, { context }) as { address: string };
  assert.equal(requested.address, "address-3.near");
  assert.deepEqual(await call(router.deposit, { requestId: "job-1" }, { context }), requested);
  assert.equal(sent.length, 3);
  assert.equal((await call(router.depositStatus, { requestId: "job-1" }, { context })).state, "ready");
  assert.equal((await call(router.depositStatus, { requestId: "job-2" }, { context })).state, "not_found");
});
