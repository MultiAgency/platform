import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { freshDirectory } from "./fixtures/harness.js";

process.env.NEAR_INTENTS_AGENT_API_KEY ??= "offline-limit-cancel-key";
process.env.AGENT_ID = "a".repeat(64);
process.env.AGENT_GRANT_TOKEN = "offline-limit-cancel-grant";
process.env.EXECUTOR = "on";

const { api } = await import("../src/api.js");
const { dispatch } = await import("../src/agent.js");
const { acquireMoneyLock } = await import("../src/lock.js");
const { mandateDigest } = await import("../src/mandate.js");
const { limitOrderText } = await import("../src/contract/limit-orders.js");
const { readOps, record, claimSubmission } = await import("../src/ops.js");
const { recover } = await import("../src/recover.js");
const { refreshLimitOrder } = await import("../src/limit-orders/service.js");
const { treasuryPolicy, ASSETS } = await import("../src/policy.js");
const { strategyDigest } = await import("../src/strategy-digest.js");
const { loadStrategy } = await import("../src/strategy.js");
const { claimOrderCancellation, claimOrderProposal, loadOrderProposal, orderProposalIdOf, readOrderCancellation, readOrderObservations, saveOrderApproval,
  saveOrderPlacement, saveOrderProposal } = await import("../src/limit-orders/store.js");
const { fixtureGrant } = await import("./fixtures/authority.js");

freshDirectory("limit-order-cancel");
beforeEach(() => {
  process.env.AGENT_ID = "a".repeat(64);
  process.env.AGENT_GRANT_TOKEN = "offline-limit-cancel-grant";
  process.env.EXECUTOR = "on";
});

function placedOrder(requestId: string) {
  const now = Date.now();
  const actor = "app:treasury:org_1";
  const id = orderProposalIdOf(actor, requestId);
  const order = { base_asset: ASSETS.wNEAR, quote_asset: ASSETS.USDC, side: "sell" as const,
    quantity: "1000000000000000000000000", price: "2.5", deadline: new Date(now + 3_600_000).toISOString(), confidential: true };
  saveOrderProposal({ version: 1, id, requestId, actor, consent: "c".repeat(64), deployment: "treasury",
    organization: "org_1", agentId: process.env.AGENT_ID!, order, spendAsset: ASSETS.wNEAR,
    spendAmount: order.quantity, outputAsset: ASSETS.USDC, policyRevision: 1,
    policyDigest: mandateDigest(treasuryPolicy), strategyDigest: strategyDigest(loadStrategy()),
    createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3_000_000).toISOString(), note: null });
  const loaded = loadOrderProposal(id)!;
  saveOrderApproval(id, { message: limitOrderText({ ...loaded.record, sha256: loaded.sha256 }, "approve"), nonce: "nonce", publicKey: "owner-key",
    signature: "signature", host: "platform.test", at: new Date().toISOString() });
  const placementKey = `limit-order:${id}`;
  assert.equal(claimOrderProposal(id, placementKey), true);
  record({ at: new Date().toISOString(), idempotencyKey: placementKey, kind: "limit-order", journalVersion: 2,
    method: "limit_order", request: order });
  claimSubmission(placementKey, order);
  record({ idempotencyKey: placementKey, correlation_id: "placed-correlation", status: "SUCCESS" });
  saveOrderPlacement(id, { correlationId: "placed-correlation", orderId: `provider-${requestId}`, at: new Date().toISOString() });
  return id;
}

test("a lost cancellation answer is never retried; partial fills and pending payout keep sends blocked", async t => {
  const id = placedOrder("cancel-race");
  let phase = "open";
  t.mock.method(api, "getLimitOrder", async () => ({ order_id: `provider-cancel-race`,
    fill_status: phase === "complete" ? "canceled" : phase === "open" ? "partially_filled" : "pending_cancel",
    payout_status: phase === "complete" ? "completed" : "in_progress", is_payout_status_final: phase === "complete",
    partial_fills: [{ fill: "first slice" }], payouts: { refund: phase === "complete" ? { state: "completed" } : null } }) as never);
  t.mock.method(api, "listGrants", async () => [fixtureGrant("treasury")] as never);
  let posts = 0;
  t.mock.method(api, "forGrant", () => ({ cancelLimitOrder: async (_agent: string, orderId: string) => {
    posts++;
    assert.equal(orderId, "provider-cancel-race");
    phase = "pending";
    throw new Error("reply lost after provider accepted cancellation");
  } }) as never);

  const lock = await acquireMoneyLock();
  try {
    const read = await dispatch(lock, "limit-order-cancel", { method: "limit_order_cancel", request: { proposalId: id } });
    assert.equal(read.fill_status, "pending_cancel");
  } finally { await lock.release(); }
  assert.equal(posts, 1);
  assert.equal(readOrderCancellation(id)?.orderId, "provider-cancel-race");
  assert.equal(readOps().find(op => op.method === "limit_order_cancel")?.submissionState, "SUBMISSION_ATTEMPTED");
  assert.equal(readOps().find(op => op.method === "limit_order_cancel")?.cancelFinal, undefined);
  await assert.rejects(acquireMoneyLock(), /earlier money action/);
  assert.equal(posts, 1, "a retry cannot make a second provider cancellation");
  assert.equal((await recover()).find(row => row.op.method === "limit_order_cancel")?.outcome, "open");
  phase = "complete";
  assert.equal((await recover()).find(row => row.op.method === "limit_order_cancel")?.outcome, "settled");
  assert.equal(readOps().find(op => op.method === "limit_order_cancel")?.cancelFinal, true);
  assert.equal(posts, 1);
  assert.ok(readOrderObservations(id).length >= 3, "each fill/payout read is retained");
});

test("an unreadable order after cancellation stays unresolved and is resolved by a later read", async t => {
  const id = placedOrder("unreadable");
  let reads = 0;
  t.mock.method(api, "getLimitOrder", async () => {
    reads++;
    if (reads === 1) return { order_id: "provider-unreadable", fill_status: "open", payout_status: "not_started",
      is_payout_status_final: false } as never;
    if (reads === 2) throw new Error("provider read unavailable");
    return { order_id: "provider-unreadable", fill_status: "expired", payout_status: "completed",
      is_payout_status_final: true, payouts: { refund: { state: "completed" } } } as never;
  });
  t.mock.method(api, "listGrants", async () => [fixtureGrant("treasury")] as never);
  let posts = 0;
  t.mock.method(api, "forGrant", () => ({ cancelLimitOrder: async () => { posts++; return { order_id: "provider-unreadable" }; } }) as never);
  const lock = await acquireMoneyLock();
  try { await assert.rejects(dispatch(lock, "limit-order-cancel", { method: "limit_order_cancel", request: { proposalId: id } }),
    /provider read unavailable/); }
  finally { await lock.release(); }
  assert.equal(readOps().find(op => op.method === "limit_order_cancel")?.cancelFinal, undefined);
  assert.equal((await recover()).find(row => row.op.method === "limit_order_cancel")?.outcome, "settled");
  assert.equal(posts, 1);
});

test("app refresh cannot resolve a cancellation whose durable claim is damaged", async t => {
  const id = placedOrder("damaged-cancel-claim");
  const orderId = "provider-damaged-cancel-claim";
  assert.equal(claimOrderCancellation(id, orderId), true);
  const key = `limit-order-cancel:${id}`;
  const request = { proposalId: id, orderId };
  record({ at: new Date().toISOString(), idempotencyKey: key, kind: "limit-order-cancel",
    journalVersion: 2, method: "limit_order_cancel", request });
  claimSubmission(key, request);
  writeFileSync(join(".proposals", "limit-orders", process.env.AGENT_ID!, `${id}.cancel.json`), "{damaged");
  t.mock.method(api, "getLimitOrder", async () => ({ order_id: orderId, fill_status: "canceled",
    payout_status: "completed", is_payout_status_final: true }) as never);
  const context = { actor: "app:treasury:org_1", consent: "c".repeat(64), host: "platform.test",
    consents: ["c".repeat(64)] } as never;
  await assert.rejects(refreshLimitOrder(context, { id }), /Invalid limit-order state/);
  assert.equal(readOps().find(op => op.idempotencyKey === key)?.cancelFinal, undefined);
  await assert.rejects(acquireMoneyLock(), /earlier money action/);
});
