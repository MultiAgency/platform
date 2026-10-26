import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import lockfile from "proper-lockfile";
import { AgentApi, AgentApiError } from "@near-intents-agent-api/sdk";
import { type Action, dispatch, LocalRefusal, pay, send } from "../src/agent.js";
import { api } from "../src/api.js";
import { acquireMoneyLock, type MoneyLock, UnresolvedOperations } from "../src/lock.js";
import { AuthorizationHeld, type Op, provenRefusal, readOps, record } from "../src/ops.js";
import { mandateDigest } from "../src/mandate.js";
import { ASSETS, payoutPolicy, treasuryPolicy } from "../src/policy.js";
import { authorityFixture, policyView } from "./fixtures/authority.js";
import { freshDirectory, offline } from "./fixtures/harness.js";

const action: Action = { method: "transfer", request: { asset: ASSETS.USDC, amount: "1", recipient: "fixture.near", confidential: true } };
const policy = policyView(payoutPolicy(["fixture.near"]));
let calls: string[];
let answer: () => Promise<{ correlation_id: string }>;
let status: string;

freshDirectory("money-safety");
beforeEach(() => {
  process.env.AGENT_GRANT_TOKEN = "ngt_fixture";
  calls = [];
  status = "FAILED";
  answer = async () => ({ correlation_id: "fixture-op" });
  offline();
  for (const [name, method] of Object.entries(authorityFixture())) mock.method(api, name as keyof typeof api, method as never);
  mock.method(api, "getPolicy", async () => policy);
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, status }));
  const method = async (_id: string, _request: unknown, options: { idempotencyKey: string }) => {
    calls.push(options.idempotencyKey);
    return answer();
  };
  mock.method(api, "forGrant", () => ({ transfer: method, swap: method, shield: method, unshield: method }));
});
afterEach(() => mock.restoreAll());

test("only recognized, consistent, non-retryable provider errors prove refusal", () => {
  const error = (status: number, code: string, retryable = false) => new AgentApiError(status, {
    errors: [{ status: String(status), code, layer: "request", title: code, meta: { retryable } }],
    meta: {},
  });
  for (const code of ["policy_denied", "spend_budget_exceeded"]) {
    assert.equal(provenRefusal(error(403, code)), code);
    assert.equal(provenRefusal(error(403, code, true)), undefined);
    assert.equal(provenRefusal(error(503, code)), undefined);
  }
  for (const code of ["route_unavailable", "quote_unavailable", "spend_price_unavailable"]) {
    assert.equal(provenRefusal(error(503, code)), code);
    assert.equal(provenRefusal(error(503, code, true)), undefined);
  }
  // SDK 0.5: `retryable: false` never proves nothing was sent. Codes without established non-execution semantics
  // (including 0.5's deposit quota, expiry and deletion outcomes) stay unproven, so the operation stays unresolved.
  for (const [status, code] of [[429, "deposit_quota_exceeded"], [409, "deposit_expired"], [409, "agent_deleted"], [500, "internal_error"], [502, "bad_gateway"]] as const)
    assert.equal(provenRefusal(error(status, code)), undefined, `${status} ${code}`);
  assert.equal(provenRefusal(new AgentApiError(409, { errors: [
    { status: "409", code: "policy_denied", layer: "policy", title: "Denied" },
    { status: "409", code: "unknown_error", layer: "provider", title: "Unknown" },
  ], meta: {} })), undefined);
  assert.equal(provenRefusal(new AgentApiError(409, { errors: [
    { status: "403", code: "policy_denied", layer: "policy", title: "Denied" },
  ], meta: {} })), undefined);
});

test("a proven first-submission refusal resolves only that operation", async () => {
  // Another unresolved operation that does not block sends: a payout held for the owner's approval.
  record({ at: new Date().toISOString(), idempotencyKey: "fixture:held", kind: "fixture", method: action.method, request: { ...action.request, amount: "999" } });
  record({ idempotencyKey: "fixture:held", correlation_id: "held-correlation", status: "PENDING_APPROVAL" });
  answer = async () => { throw new AgentApiError(409, {
    errors: [{ status: "409", code: "policy_denied", layer: "policy", title: "Policy denied" }], meta: {},
  }); };
  const lock = await acquireMoneyLock();
  try { await assert.rejects(dispatch(lock, "fixture", action), AgentApiError); } finally { await lock.release(); }
  const ops = new Map(readOps().map(op => [op.idempotencyKey, op]));
  assert.equal(ops.size, 2);
  assert.equal([...ops.values()].find(op => op.idempotencyKey !== "fixture:held")?.refused, "policy_denied");
  assert.equal(ops.get("fixture:held")?.refused, undefined, "the held payout is not resolved by another operation's refusal");
  assert.equal(ops.get("fixture:held")?.status, "PENDING_APPROVAL");
  assert.equal(calls.length, 1);
});

test("a swap into an asset outside the policy is refused before sending, and logged with its mandate", async () => {
  mock.method(api, "getPolicy", async () => policyView(treasuryPolicy, 7));
  mock.method(api, "listGrants", authorityFixture("treasury").listGrants);
  const lock = await acquireMoneyLock();
  try {
    const swap = { origin_asset: ASSETS.USDC, destination_asset: "nep141:usdt.tether-token.near", amount: "2000000", confidential: true };
    await assert.rejects(dispatch(lock, "rebalance", { method: "swap", request: swap }), LocalRefusal);
  } finally {
    await lock.release();
  }
  const [op] = readOps();
  assert.equal(op?.refused, "asset_out_not_allowed");
  assert.deepEqual(calls, [], "nothing was sent");
  assert.equal(op?.policyRevision, 7);
  assert.equal(op?.policyDigest, mandateDigest(treasuryPolicy));
  assert.equal(op?.usdIn, 2);
  // A refusal is a proven outcome: it doesn't block the next money action.
  await (await acquireMoneyLock()).release();
});

test("a lock taken over by another process (proper-lockfile's onCompromised) during preflight sends and records nothing", async () => {
  // Capture the callback acquireMoneyLock gives proper-lockfile, then fire it as a takeover would.
  let compromise: (() => void) | undefined;
  const lock = lockfile.lock;
  mock.method(lockfile, "lock", (file: string, options: Parameters<typeof lockfile.lock>[1]) => {
    compromise = () => options!.onCompromised!(new Error("lock taken over"));
    return lock(file, options);
  });
  const money = await acquireMoneyLock();
  mock.method(api, "getPolicy", async () => { compromise!(); return policy; });
  await assert.rejects(dispatch(money, "fixture", action), /money lock/);
  assert.equal(money.held, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(readOps(), []);
});

test("lock lost during asynchronous preflight produces zero sends and zero request records", async () => {
  const lock = await acquireMoneyLock();
  mock.method(api, "getPolicy", async () => { await lock.release(); return policy; });
  await assert.rejects(dispatch(lock, "fixture", action), /money lock/);
  assert.deepEqual(calls, []);
  assert.deepEqual(readOps(), []);
});

test("an unresolved operation appearing during preflight blocks before recording a new request", async () => {
  const lock = await acquireMoneyLock();
  try {
    mock.method(api, "getPolicy", async () => {
      await Promise.resolve();
      record({ at: new Date().toISOString(), idempotencyKey: "fixture:unknown", kind: "fixture", method: action.method, request: action.request });
      return policy;
    });
    await assert.rejects(dispatch(lock, "fixture", action), UnresolvedOperations);
    assert.deepEqual(calls, []);
    assert.deepEqual(readOps().map((op) => op.idempotencyKey), ["fixture:unknown"]);
  } finally { await lock.release(); }
});

test("an unknown outcome blocks a subsequent dispatch within the same held lock", async () => {
  const lock = await acquireMoneyLock();
  try {
    status = "UNCERTAIN";
    await dispatch(lock, "fixture", action);
    await assert.rejects(dispatch(lock, "fixture", action), UnresolvedOperations);
    assert.equal(calls.length, 1);
    assert.equal(readOps().length, 1);
  } finally { await lock.release(); }
});

test("a direct send under the held lock without dispatch's permit is refused, even for a recorded never-submitted operation", async () => {
  const lock = await acquireMoneyLock();
  try {
    // Recorded under the held lock, as dispatch records before sending.
    record({ at: new Date().toISOString(), idempotencyKey: "fixture:replay", kind: "fixture", method: action.method, request: action.request });
    await assert.rejects(send(action, "fixture:replay", lock), (error: unknown) => error instanceof AuthorizationHeld && /direct replay is blocked/.test(error.message));
    assert.deepEqual(calls, []);
  } finally { await lock.release(); }
});

test("replay also refuses a lost lock without sending", async () => {
  const lock: MoneyLock = { held: false, release: async () => {} };
  await assert.rejects(send(action, "fixture:original-key", lock), /money lock/);
  assert.deepEqual(calls, []);
});

test("a payout's retryable API failure is not presented as a policy refusal", async () => {
  answer = async () => { throw new AgentApiError(503, {
    errors: [{ status: "503", code: "unavailable", layer: "provider", title: "Unavailable", meta: { retryable: true } }], meta: {},
  }); };
  await assert.rejects(pay({ asset: ASSETS.USDC, amount: "1", recipient: "fixture.near", confidential: true }), AgentApiError);
  assert.equal(calls.length, 1);
  assert.equal(readOps()[0]?.refused, undefined);
});

for (const response of [
  { name: "HTML timeout", status: 408, body: "<html>Request Timeout</html>" },
  { name: "empty conflict", status: 409, body: "" },
  { name: "unknown structured error", status: 400, body: JSON.stringify({ errors: [{ status: "400", code: "new_unknown_error", title: "Unknown" }] }) },
]) test(`${response.name} after submission remains unresolved and blocks a replacement`, async () => {
  const sdk = new AgentApi({ apiKey: process.env.NEAR_INTENTS_AGENT_API_KEY!, fetch: async () => new Response(response.body, { status: response.status }) });
  answer = () => sdk.forGrant(`ngt_${"a".repeat(43)}`).transfer(process.env.AGENT_ID!, action.request as never);
  await assert.rejects(pay(action.request as never), AgentApiError);
  assert.equal(readOps()[0]?.refused, undefined);
  assert.equal(readOps()[0]?.submissionState, "SUBMISSION_ATTEMPTED");
  await assert.rejects(pay(action.request as never), UnresolvedOperations);
  assert.equal(calls.length, 1);
});

test("the unresolved refusal says what reconcile can poll and what it cannot resolve", () => {
  const op = (idempotencyKey: string, correlationId?: string) => ({ idempotencyKey, at: "2026-10-19T00:00:00Z", kind: "payout", request: {}, ...(correlationId && { correlationId }) }) as Op;
  const polled = new UnresolvedOperations([op("payout:a", "provider-op")]).message;
  assert.match(polled, /payout:a/);
  assert.match(polled, /`pnpm reconcile --poll` reads their outcomes/);
  assert.doesNotMatch(polled, /no operation ID/);
  // A lost provider reply leaves no operation ID: reconcile can't resolve it, so the message must not promise it will.
  const lost = new UnresolvedOperations([op("payout:a", "provider-op"), op("payout:b")]).message;
  assert.match(lost, /payout:b has no operation ID/);
  assert.match(lost, /reconcile cannot resolve/);
  assert.match(lost, /docs\/enforcement\.md/);
  assert.doesNotMatch(new UnresolvedOperations([op("payout:b")]).message, /reconcile --poll/);
});
