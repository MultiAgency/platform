import assert from "node:assert/strict";
import { beforeEach, test, type TestContext } from "node:test";
import { freshDirectory, offline } from "./fixtures/harness.js";

process.env.NEAR_INTENTS_AGENT_API_KEY ??= "offline-limit-cancel-recovery-key";
process.env.AGENT_ID = "a".repeat(64);
process.env.AGENT_GRANT_TOKEN = "offline-limit-cancel-recovery-grant";
process.env.EXECUTOR = "on";

const { api } = await import("../src/api.js");
const { limitOrderText, limitOrderView } = await import("../src/contract/limit-orders.js");
const { mandateDigest } = await import("../src/mandate.js");
const { acquireMoneyLock } = await import("../src/lock.js");
const { readOps, record } = await import("../src/ops.js");
const { recover } = await import("../src/recover.js");
const { cancelLimitOrder, getLimitOrder, refreshLimitOrder } = await import("../src/limit-orders/service.js");
const { ASSETS, treasuryPolicy } = await import("../src/policy.js");
const { loadStrategy } = await import("../src/strategy.js");
const { strategyDigest } = await import("../src/strategy-digest.js");
const { claimOrderCancellation, claimOrderProposal, loadOrderProposal, orderProposalIdOf, saveOrderApproval,
  saveOrderPlacement, saveOrderProposal } = await import("../src/limit-orders/store.js");
const { claimSubmission } = await import("../src/ops.js");
const { fixtureGrant } = await import("./fixtures/authority.js");

freshDirectory("limit-order-cancel-recovery");
beforeEach(() => {
  offline();
  process.env.AGENT_ID = "a".repeat(64);
  process.env.AGENT_GRANT_TOKEN = "offline-limit-cancel-recovery-grant";
  process.env.EXECUTOR = "on";
});

const app = { actor: "app:treasury:org_1", consent: "c".repeat(64), host: "platform.test",
  consents: ["c".repeat(64)] } as never;

function placedOrder(requestId: string) {
  const now = Date.now();
  const id = orderProposalIdOf("app:treasury:org_1", requestId);
  const order = { base_asset: ASSETS.wNEAR, quote_asset: ASSETS.USDC, side: "sell" as const,
    quantity: "1000000000000000000000000", price: "2.5", deadline: new Date(now + 3_600_000).toISOString(), confidential: true };
  saveOrderProposal({ version: 1, id, requestId, actor: "app:treasury:org_1", consent: "c".repeat(64),
    deployment: "treasury", organization: "org_1", agentId: process.env.AGENT_ID!, order,
    spendAsset: ASSETS.wNEAR, spendAmount: order.quantity, outputAsset: ASSETS.USDC, policyRevision: 1,
    policyDigest: mandateDigest(treasuryPolicy), strategyDigest: strategyDigest(loadStrategy()),
    createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3_000_000).toISOString(), note: null });
  const loaded = loadOrderProposal(id)!;
  saveOrderApproval(id, { message: limitOrderText({ ...loaded.record, sha256: loaded.sha256 }, "approve"),
    nonce: "nonce", publicKey: "owner-key", signature: "signature", host: "platform.test", at: new Date().toISOString() });
  const placementKey = `limit-order:${id}`;
  assert.equal(claimOrderProposal(id, placementKey), true);
  record({ at: new Date().toISOString(), idempotencyKey: placementKey, kind: "limit-order", journalVersion: 2,
    method: "limit_order", request: order });
  claimSubmission(placementKey, order);
  record({ idempotencyKey: placementKey, correlation_id: "placed-correlation", status: "SUCCESS" });
  const orderId = `provider-${requestId}`;
  saveOrderPlacement(id, { correlationId: "placed-correlation", orderId, at: new Date().toISOString() });
  return { id, orderId, key: `limit-order-cancel:${id}`, request: { proposalId: id, orderId } };
}

function provider(t: TestContext, orderId: string) {
  let phase: "open" | "pending" | "complete" = "open";
  let posts = 0;
  t.mock.method(api, "getLimitOrder", async () => ({ order_id: orderId,
    fill_status: phase === "complete" ? "canceled" : phase === "pending" ? "pending_cancel" : "open",
    payout_status: phase === "complete" ? "completed" : phase === "pending" ? "in_progress" : "not_started",
    is_payout_status_final: phase === "complete" }) as never);
  t.mock.method(api, "listGrants", async () => [fixtureGrant("treasury")] as never);
  t.mock.method(api, "forGrant", () => ({ cancelLimitOrder: async (_agent: string, received: string) => {
    assert.equal(received, orderId);
    posts++;
    phase = "pending";
    return { order_id: orderId };
  } }) as never);
  return { posts: () => posts, complete: () => { phase = "complete"; } };
}

for (const window of ["claim only", "prepared operation"] as const) {
  test(`a cancellation ${window} after a crash resumes one proven-unsent POST, then recovery only reads`, async t => {
    const { id, orderId, key, request } = placedOrder(`resume-${window.replaceAll(" ", "-")}`);
    assert.equal(claimOrderCancellation(id, orderId), true);
    if (window === "prepared operation") record({ at: new Date().toISOString(), idempotencyKey: key,
      kind: "limit-order-cancel", journalVersion: 2, method: "limit_order_cancel", request,
      policyRevision: null, policyDigest: null, originalOrderPolicyDigest: mandateDigest(treasuryPolicy) });
    const remote = provider(t, orderId);

    await recover();
    assert.equal(remote.posts(), 0, "status recovery cannot turn an unsent cancellation into a POST");
    const before = limitOrderView.parse(getLimitOrder(app, { id }));
    const first = await cancelLimitOrder(app, { id });
    assert.equal(remote.posts(), 1, "the app's explicit cancel resumes its sole provider POST");
    assert.equal(before.cancelMayResume, true,
      "the app can distinguish a proven-unsent claim from an ambiguous cancel attempt");
    assert.equal(first.state, "cancel_requested");
    const attempted = readOps().find(op => op.idempotencyKey === key);
    assert.deepEqual(attempted?.request, request);
    assert.equal(attempted?.submissionState, "SUBMISSION_ATTEMPTED");
    assert.equal(attempted?.originalOrderPolicyDigest, mandateDigest(treasuryPolicy));
    assert.equal(attempted?.cancelFinal, undefined);
    const after = limitOrderView.parse(getLimitOrder(app, { id }));
    assert.equal(after.cancelMayResume, false,
      "a submission claim closes the recovery window for another POST");

    await cancelLimitOrder(app, { id });
    await recover();
    assert.equal(remote.posts(), 1, "a repeat request and recovery never replay a claimed POST");
    remote.complete();
    await recover();
    assert.equal(readOps().find(op => op.idempotencyKey === key)?.cancelFinal, true);
    assert.equal(remote.posts(), 1);
  });
}

test("a pre-submission cancellation claim with a different journal order ID fails closed", async t => {
  const { id, orderId, key } = placedOrder("mismatched-request");
  assert.equal(claimOrderCancellation(id, orderId), true);
  record({ at: new Date().toISOString(), idempotencyKey: key, kind: "limit-order-cancel", journalVersion: 2,
    method: "limit_order_cancel", request: { proposalId: id, orderId: "another-provider-order" },
    policyRevision: null, policyDigest: null, originalOrderPolicyDigest: mandateDigest(treasuryPolicy) });
  const remote = provider(t, orderId);
  await assert.rejects(cancelLimitOrder(app, { id }), /cancel|order|identity|mismatch/i);
  assert.equal(remote.posts(), 0);
});

test("a prepared cancellation cannot bypass another unresolved money action", async t => {
  const { id, orderId, key, request } = placedOrder("another-unresolved-send");
  assert.equal(claimOrderCancellation(id, orderId), true);
  record({ at: new Date().toISOString(), idempotencyKey: key, kind: "limit-order-cancel", journalVersion: 2,
    method: "limit_order_cancel", request, policyRevision: null, policyDigest: null,
    originalOrderPolicyDigest: mandateDigest(treasuryPolicy) });
  const other = { asset: ASSETS.USDC, amount: "1", recipient: "receiver.near" };
  record({ at: new Date().toISOString(), idempotencyKey: "other-unresolved", kind: "payout", journalVersion: 2,
    method: "transfer", request: other });
  claimSubmission("other-unresolved", other);
  const remote = provider(t, orderId);
  await assert.rejects(cancelLimitOrder(app, { id }), /earlier money action/);
  assert.equal(remote.posts(), 0);
  assert.equal(readOps().find(op => op.idempotencyKey === key)?.submissionState, "PREPARED");
});

test("a failed final payout does not retire a proven-unsent cancellation for new sends", async t => {
  const { id, orderId, key, request } = placedOrder("failed-payout-before-cancel");
  assert.equal(claimOrderCancellation(id, orderId), true);
  record({ at: new Date().toISOString(), idempotencyKey: key, kind: "limit-order-cancel", journalVersion: 2,
    method: "limit_order_cancel", request, policyRevision: null, policyDigest: null,
    originalOrderPolicyDigest: mandateDigest(treasuryPolicy) });
  t.mock.method(api, "getLimitOrder", async () => ({ order_id: orderId, fill_status: "canceled",
    payout_status: "failed", is_payout_status_final: true }) as never);
  const result = await recover();
  assert.equal(result.find(row => row.op.idempotencyKey === key)?.outcome, "unknown");
  assert.equal(readOps().find(op => op.idempotencyKey === key)?.refused, undefined);
  assert.equal(getLimitOrder(app, { id }).cancelMayResume, false);
  await assert.rejects(acquireMoneyLock(), /earlier money action/);
});

test("a claim-only crash needs no retry once the order is payout-final", async t => {
  const { id, orderId } = placedOrder("closed-before-cancel");
  assert.equal(claimOrderCancellation(id, orderId), true);
  t.mock.method(api, "getLimitOrder", async () => ({ order_id: orderId, fill_status: "canceled",
    payout_status: "completed", is_payout_status_final: true }) as never);
  const result = await refreshLimitOrder(app, { id });
  assert.equal(result.state, "completed");
  assert.equal(result.cancelMayResume, false);
});

test("refresh cannot complete a cancellation journal with a foreign original mandate", async t => {
  const { id, orderId, key, request } = placedOrder("foreign-original-mandate");
  assert.equal(claimOrderCancellation(id, orderId), true);
  record({ at: new Date().toISOString(), idempotencyKey: key, kind: "limit-order-cancel", journalVersion: 2,
    method: "limit_order_cancel", request, policyRevision: null, policyDigest: null,
    originalOrderPolicyDigest: "sha256:" + "0".repeat(64) });
  claimSubmission(key, request);
  t.mock.method(api, "getLimitOrder", async () => ({ order_id: orderId, fill_status: "canceled",
    payout_status: "completed", is_payout_status_final: true }) as never);
  await assert.rejects(refreshLimitOrder(app, { id }), /mismatched cancellation journal/);
  assert.equal(readOps().find(op => op.idempotencyKey === key)?.cancelFinal, undefined);
});
