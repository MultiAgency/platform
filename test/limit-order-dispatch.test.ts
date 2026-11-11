import assert from "node:assert/strict";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test, type TestContext } from "node:test";
import type { Policy } from "@near-intents-agent-api/sdk";
import type { OrderProposalRecord } from "../src/limit-orders/store.js";
import { freshDirectory } from "./fixtures/harness.js";

// The API client reads its key at import, while every test keeps its records in a fresh directory.
const AGENT = "a".repeat(64);
process.env.NEAR_INTENTS_AGENT_API_KEY ??= "offline-limit-order-key";
process.env.AGENT_ID = AGENT;
process.env.AGENT_GRANT_TOKEN = "offline-limit-order-grant";
process.env.EXECUTOR = "on";

const { api } = await import("../src/api.js");
const { dispatch, send } = await import("../src/agent.js");
const { acquireMoneyLock, assertCanDispatch } = await import("../src/lock.js");
const { mandateDigest } = await import("../src/mandate.js");
const { limitOrderText } = await import("../src/contract/limit-orders.js");
const { claimSubmission, readOps, opsLog, record } = await import("../src/ops.js");
const { recover } = await import("../src/recover.js");
const { ASSETS, treasuryPolicy } = await import("../src/policy.js");
const { loadStrategy } = await import("../src/strategy.js");
const { strategyDigest } = await import("../src/strategy-digest.js");
const { claimOrderProposal, loadOrderProposal, orderProposalIdOf, readOrderFinal, readOrderPlacement, saveOrderApproval, saveOrderPlacement,
  saveOrderProposal } = await import("../src/limit-orders/store.js");
const { fixtureGrant, policyView, timedPrices } = await import("./fixtures/authority.js");

freshDirectory("limit-order-dispatch");
beforeEach(() => {
  process.env.AGENT_ID = AGENT;
  process.env.AGENT_GRANT_TOKEN = "offline-limit-order-grant";
  process.env.EXECUTOR = "on";
  delete process.env.DASHBOARD_AREA;
});

const policy: Policy = { ...treasuryPolicy, actions: ["swap", "limit_order"], limit_order: { max_deviation_bps: 300 } };
const baseAsset = ASSETS.wNEAR;
const quoteAsset = ASSETS.USDC;
const quantity = "1000000000000000000000000"; // one whole base token, in atomic units
const amount = "2500000"; // 2.5 whole USDC, in atomic units

function approvedProposal(requestId: string): OrderProposalRecord {
  const now = Date.now();
  const actor = "app:treasury:org_1";
  const proposal: OrderProposalRecord = {
    version: 1, id: orderProposalIdOf(actor, requestId), requestId, actor,
    consent: "c".repeat(64), deployment: "treasury", organization: "org_1", agentId: AGENT,
    order: { base_asset: baseAsset, quote_asset: quoteAsset, side: "buy", quantity, price: "2.5",
      deadline: new Date(now + 2 * 60 * 60_000).toISOString(), confidential: true },
    spendAsset: quoteAsset, spendAmount: amount, outputAsset: baseAsset,
    policyRevision: 2, policyDigest: mandateDigest(policy), strategyDigest: strategyDigest(loadStrategy()),
    createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60 * 60_000).toISOString(),
    note: "Buy one base token at the owner's limit",
  };
  assert.equal(saveOrderProposal(proposal), true);
  const loaded = loadOrderProposal(proposal.id)!;
  assert.equal(saveOrderApproval(proposal.id, { message: limitOrderText({ ...loaded.record, sha256: loaded.sha256 }, "approve"), nonce: "offline-nonce",
    publicKey: "ed25519:offline-owner", signature: "offline-signature", host: "platform.test",
    at: new Date(now).toISOString() }), true);
  return proposal;
}

function mockPreflight(t: TestContext, previewAmount = amount, afterPolicy?: () => void) {
  t.mock.method(api, "getPolicy", async () => { afterPolicy?.(); return policyView(policy, 2) as never; });
  t.mock.method(api, "getTokens", async () => timedPrices([
    { asset_id: baseAsset, symbol: "wNEAR", decimals: 24, price: 2.5 },
    { asset_id: quoteAsset, symbol: "USDC", decimals: 6, price: 1 },
  ]) as never);
  t.mock.method(api, "listGrants", async () => [fixtureGrant("treasury")] as never);
  const preview = t.mock.method(api, "placeLimitOrder", async (_id: string, request: { dry?: boolean }) => {
    assert.equal(request.dry, true, "preflight never makes a live placement");
    return { type: "limit_order", dry: true, warnings: [], quote: { spend_asset: quoteAsset, spend_amount: previewAmount } } as never;
  });
  return preview;
}

async function place(proposal: OrderProposalRecord) {
  const lock = await acquireMoneyLock();
  try {
    return await dispatch(lock, "limit-order", { method: "limit_order", request: proposal.order },
      undefined, undefined, undefined, undefined, undefined, undefined, { proposalId: proposal.id });
  } finally { await lock.release(); }
}

test("an owner-approved proposal places once under the money lock and saves order identity before terminal status", async t => {
  const proposal = approvedProposal("place-once");
  const preview = mockPreflight(t);
  let submissions = 0;
  t.mock.method(api, "forGrant", () => ({ placeLimitOrder: async (id: string, request: unknown, options: { idempotencyKey: string }) => {
    submissions++;
    assert.equal(id, AGENT);
    assert.deepEqual(request, proposal.order);
    assert.equal(options.idempotencyKey, `limit-order:${proposal.id}`);
    assert.equal(readOrderFinal(proposal.id)?.state, "claimed", "the owner approval is claimed before I/O");
    assert.equal(readOps()[0]?.submissionState, "SUBMISSION_ATTEMPTED", "journal claim precedes I/O");
    return { correlation_id: "correlation-placed" };
  } }) as never);
  t.mock.method(api, "getStatus", async () => ({ correlation_id: "correlation-placed", agent_id: AGENT,
    type: "limit_order", status: "SUCCESS", details: { order_id: "provider-order-1" } }) as never);

  const lock = await acquireMoneyLock();
  try {
    await assert.rejects(send({ method: "limit_order", request: proposal.order }, `limit-order:${proposal.id}`, lock),
      /submission must pass through dispatch/);
    assert.deepEqual(readOps(), [], "direct send never prepares a journal entry");
    assert.equal((await dispatch(lock, "limit-order", { method: "limit_order", request: proposal.order },
      undefined, undefined, undefined, undefined, undefined, undefined, { proposalId: proposal.id })).status, "SUCCESS");
  } finally { await lock.release(); }

  assert.equal(submissions, 1);
  assert.equal(preview.mock.callCount(), 1);
  assert.deepEqual(readOrderPlacement(proposal.id), { correlationId: "correlation-placed", orderId: "provider-order-1",
    at: readOrderPlacement(proposal.id)!.at });
  assert.equal(readOps()[0]?.status, "SUCCESS");
  assert.equal(readOps()[0]?.idempotencyKey, `limit-order:${proposal.id}`);
  const lines = readFileSync(opsLog(), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(lines.map(line => line.submissionState ?? line.status ?? "prepared"),
    ["prepared", "SUBMISSION_ATTEMPTED", "SENT", "SUCCESS"]);
  await assert.rejects(place(proposal), /already claimed|unused owner approval/);
  assert.equal(submissions, 1, "a completed proposal has no second placement");
});

for (const missing of ["placed", "final", "proposal"] as const) {
  test(`a successful placement with lost ${missing} evidence blocks every later money lock`, async () => {
    const proposal = approvedProposal(`lost-${missing}`);
    const key = `limit-order:${proposal.id}`;
    assert.equal(claimOrderProposal(proposal.id, key), true);
    record({ at: new Date().toISOString(), idempotencyKey: key, kind: "limit-order", journalVersion: 2,
      method: "limit_order", request: proposal.order });
    claimSubmission(key, proposal.order);
    record({ idempotencyKey: key, correlation_id: "correlation-lost-evidence", status: "SENT" });
    saveOrderPlacement(proposal.id, { correlationId: "correlation-lost-evidence", orderId: "provider-funded-order",
      at: new Date().toISOString() });
    record({ idempotencyKey: key, correlation_id: "correlation-lost-evidence", status: "SUCCESS" });
    const suffix = missing === "proposal" ? ".json" : `.${missing}.json`;
    unlinkSync(join(".proposals", "limit-orders", AGENT, `${proposal.id}${suffix}`));
    await assert.rejects(acquireMoneyLock(), /Successful limit order|placement evidence without a claim/,
      "a terminal journal line alone cannot prove the funded order is tracked");
    if (missing === "placed") await assert.rejects(recover(), /lost its provider order identity/,
      "status-only recovery must surface the missing order identity, not silently report no work");
  });
}

test("a money lock already held refuses a new send when funded order identity disappears", async () => {
  const proposal = approvedProposal("lost-during-lock");
  const key = `limit-order:${proposal.id}`;
  assert.equal(claimOrderProposal(proposal.id, key), true);
  record({ at: new Date().toISOString(), idempotencyKey: key, kind: "limit-order", journalVersion: 2,
    method: "limit_order", request: proposal.order });
  claimSubmission(key, proposal.order);
  record({ idempotencyKey: key, correlation_id: "correlation-locked", status: "SENT" });
  saveOrderPlacement(proposal.id, { correlationId: "correlation-locked", orderId: "provider-locked",
    at: new Date().toISOString() });
  record({ idempotencyKey: key, correlation_id: "correlation-locked", status: "SUCCESS" });
  const lock = await acquireMoneyLock();
  try {
    unlinkSync(join(".proposals", "limit-orders", AGENT, `${proposal.id}.placed.json`));
    assert.throws(() => assertCanDispatch(lock), /lost its provider order identity/);
  } finally { await lock.release(); }
});

test("recovery polls unrelated unknown operations before reporting a lost funded-order identity", async t => {
  const proposal = approvedProposal("missing-while-recovering");
  const key = `limit-order:${proposal.id}`;
  assert.equal(claimOrderProposal(proposal.id, key), true);
  record({ at: new Date().toISOString(), idempotencyKey: key, kind: "limit-order", journalVersion: 2,
    method: "limit_order", request: proposal.order });
  claimSubmission(key, proposal.order);
  saveOrderPlacement(proposal.id, { correlationId: "correlation-funded", orderId: "provider-funded",
    at: new Date().toISOString() });
  record({ idempotencyKey: key, correlation_id: "correlation-funded", status: "SUCCESS" });
  unlinkSync(join(".proposals", "limit-orders", AGENT, `${proposal.id}.placed.json`));

  const other = "unrelated-unknown-operation";
  const transfer = { asset: quoteAsset, amount: "1", recipient: "recipient.near", confidential: true };
  record({ at: new Date().toISOString(), idempotencyKey: other, kind: "payout", journalVersion: 2,
    method: "transfer", request: transfer });
  claimSubmission(other, transfer);
  record({ idempotencyKey: other, correlation_id: "correlation-other", status: "SENT" });
  const read = t.mock.method(api, "getStatus", async (id: string) => ({ correlation_id: id, agent_id: AGENT,
    type: "transfer", status: "SUCCESS", details: {} }) as never);
  await assert.rejects(recover(), /lost its provider order identity/);
  assert.equal(read.mock.callCount(), 1, "the unrelated provider status was still read");
  assert.equal(readOps().find(op => op.idempotencyKey === other)?.status, "SUCCESS");
});

test("a successful placement with an altered owner approval text blocks later sends", async () => {
  const proposal = approvedProposal("altered-approval");
  const key = `limit-order:${proposal.id}`;
  assert.equal(claimOrderProposal(proposal.id, key), true);
  record({ at: new Date().toISOString(), idempotencyKey: key, kind: "limit-order", journalVersion: 2,
    method: "limit_order", request: proposal.order });
  claimSubmission(key, proposal.order);
  saveOrderPlacement(proposal.id, { correlationId: "correlation-altered", orderId: "provider-altered",
    at: new Date().toISOString() });
  record({ idempotencyKey: key, correlation_id: "correlation-altered", status: "SUCCESS" });
  const path = join(".proposals", "limit-orders", AGENT, `${proposal.id}.approval.json`);
  const approval = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...approval, message: "Approve a different order" }));
  await assert.rejects(acquireMoneyLock(), /lost its exact owner-approved proposal/);
});

test("a dry preview with a different atomic spend refuses before claiming or submitting", async t => {
  const proposal = approvedProposal("preview-mismatch");
  mockPreflight(t, "2499999");
  const live = t.mock.method(api, "forGrant", () => { throw new Error("must not acquire a live grant"); });
  await assert.rejects(place(proposal), { code: "order_preview_mismatch" });
  assert.equal(readOrderFinal(proposal.id), null);
  assert.deepEqual(readOps(), []);
  assert.equal(live.mock.callCount(), 0);
});

test("a changed approval message refuses in locked placement preflight before any provider call", async t => {
  const proposal = approvedProposal("altered-before-place");
  const path = join(".proposals", "limit-orders", AGENT, `${proposal.id}.approval.json`);
  const approval = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...approval, message: "Approve a different order" }));
  const provider = t.mock.method(api, "getPolicy", async () => { throw new Error("provider should not be called"); });
  await assert.rejects(place(proposal), { code: "order_not_approved" });
  assert.equal(provider.mock.callCount(), 0);
  assert.deepEqual(readOps(), []);
});

test("provider preflight that crosses the owner's approval expiry refuses before the one-way claim", async t => {
  const proposal = approvedProposal("expires-during-preflight");
  const expiry = Date.parse(proposal.expiresAt);
  let now = expiry - 1_000;
  t.mock.method(Date, "now", () => now);
  mockPreflight(t, amount, () => { now = expiry + 1; });
  const live = t.mock.method(api, "forGrant", () => { throw new Error("must not acquire a live grant"); });
  await assert.rejects(place(proposal), { code: "order_expired" });
  assert.equal(readOrderFinal(proposal.id), null);
  assert.deepEqual(readOps(), []);
  assert.equal(live.mock.callCount(), 0);
});

test("a lost live provider reply leaves an unresolved claimed order and recovery never replays its POST", async t => {
  const proposal = approvedProposal("lost-reply");
  mockPreflight(t);
  let submissions = 0;
  t.mock.method(api, "forGrant", () => ({ placeLimitOrder: async () => {
    submissions++;
    throw new Error("provider accepted but reply was lost");
  } }) as never);
  await assert.rejects(place(proposal), /reply was lost/);
  const op = readOps()[0]!;
  assert.equal(op.submissionState, "SUBMISSION_ATTEMPTED");
  assert.equal(op.correlationId, undefined);
  assert.equal(op.status, undefined);
  assert.equal(readOrderFinal(proposal.id)?.state, "claimed");
  assert.equal(readOrderPlacement(proposal.id), null);
  assert.deepEqual((await recover()).map(row => row.outcome), ["unknown"]);
  await assert.rejects(acquireMoneyLock(), /earlier money action/);
  assert.equal(submissions, 1, "status-only recovery did not make a second placement");
});

test("a lost status read is recovered by correlation ID, recording order ID before SUCCESS", async t => {
  const proposal = approvedProposal("recover-placement");
  mockPreflight(t);
  let submissions = 0;
  t.mock.method(api, "forGrant", () => ({ placeLimitOrder: async () => {
    submissions++;
    return { correlation_id: "correlation-recovered" };
  } }) as never);
  let reads = 0;
  t.mock.method(api, "getStatus", async () => {
    reads++;
    if (reads === 1) throw new Error("status temporarily unreadable");
    assert.equal(readOrderPlacement(proposal.id), null);
    return { correlation_id: "correlation-recovered", agent_id: AGENT, type: "limit_order",
      status: "SUCCESS", details: { order_id: "provider-order-recovered" } } as never;
  });
  await assert.rejects(place(proposal), /status temporarily unreadable/);
  assert.equal(readOps()[0]?.status, "SENT");
  assert.equal(readOrderPlacement(proposal.id), null);
  assert.deepEqual((await recover()).map(row => row.outcome), ["settled"]);
  assert.equal(readOrderPlacement(proposal.id)?.orderId, "provider-order-recovered");
  assert.equal(readOps()[0]?.status, "SUCCESS");
  assert.equal(submissions, 1);
  assert.equal(readFileSync(opsLog(), "utf8").trim().split("\n").at(-1)!.includes('"status":"SUCCESS"'), true);
});

test("recovery keeps the first placement timestamp after a crash before the terminal journal line", async t => {
  const proposal = approvedProposal("crash-after-placement");
  const key = `limit-order:${proposal.id}`;
  assert.equal(claimOrderProposal(proposal.id, key), true);
  record({ at: new Date().toISOString(), idempotencyKey: key, kind: "limit-order", journalVersion: 2,
    method: "limit_order", request: proposal.order });
  claimSubmission(key, proposal.order);
  record({ idempotencyKey: key, correlation_id: "correlation-crash", status: "SENT" });
  const firstAt = new Date(Date.now() - 1000).toISOString();
  saveOrderPlacement(proposal.id, { correlationId: "correlation-crash", orderId: "provider-crash", at: firstAt });
  t.mock.method(api, "getStatus", async () => ({ correlation_id: "correlation-crash", agent_id: AGENT,
    type: "limit_order", status: "SUCCESS", details: { order_id: "provider-crash" } }) as never);
  t.mock.method(api, "getLimitOrder", async () => ({ order_id: "provider-crash", fill_status: "open",
    payout_status: "not_started", is_payout_status_final: false }) as never);
  assert.deepEqual((await recover()).map(row => row.outcome), ["settled"]);
  assert.equal(readOps()[0]?.status, "SUCCESS");
  assert.equal(readOrderPlacement(proposal.id)?.at, firstAt);
});

test("a conflicting placement ID blocks terminal journal evidence for a successful status", async t => {
  const proposal = approvedProposal("conflicting-placement");
  mockPreflight(t);
  t.mock.method(api, "forGrant", () => ({ placeLimitOrder: async () => {
    saveOrderPlacement(proposal.id, { correlationId: "correlation-conflict", orderId: "other-order", at: new Date().toISOString() });
    return { correlation_id: "correlation-conflict" };
  } }) as never);
  t.mock.method(api, "getStatus", async () => ({ correlation_id: "correlation-conflict", agent_id: AGENT,
    type: "limit_order", status: "SUCCESS", details: { order_id: "provider-order" } }) as never);
  await assert.rejects(place(proposal), /conflicting placement evidence/);
  assert.equal(readOps()[0]?.status, "SENT", "terminal journal is written only after matching placement is durable");
  assert.equal(readOrderPlacement(proposal.id)?.orderId, "other-order");
});
