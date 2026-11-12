import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { freshDirectory } from "./fixtures/harness.js";

const AGENT = "a".repeat(64);
process.env.NEAR_INTENTS_AGENT_API_KEY ??= "offline-limit-order-key";
process.env.AGENT_ID = AGENT;

const { api } = await import("../src/api.js");
const { orderFinality, refreshOpenOrders, refreshTrackedOrder } = await import("../src/limit-orders/observe.js");
const { appendOrderObservation, claimOrderProposal, orderProposalIdOf, readOrderObservations,
  saveOrderApproval, saveOrderPlacement, saveOrderProposal } = await import("../src/limit-orders/store.js");

freshDirectory("limit-order-observe");
beforeEach(() => { process.env.AGENT_ID = AGENT; });

function placedOrder(requestId: string) {
  const now = Date.now();
  const actor = "app:treasury:org_1";
  const id = orderProposalIdOf(actor, requestId);
  const order = { base_asset: "nep141:base", quote_asset: "nep141:quote", side: "sell" as const,
    quantity: "1000000", price: "2.5", deadline: new Date(now + 2 * 60 * 60_000).toISOString(), confidential: true };
  assert.equal(saveOrderProposal({ version: 1, id, requestId, actor, consent: "c".repeat(64),
    deployment: "treasury", organization: "org_1", agentId: AGENT, order,
    spendAsset: order.base_asset, spendAmount: order.quantity, outputAsset: order.quote_asset,
    policyRevision: 2, policyDigest: `sha256:${"d".repeat(64)}`, strategyDigest: `sha256:${"e".repeat(64)}`,
    createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60 * 60_000).toISOString(), note: null }), true);
  saveOrderApproval(id, { message: "owner-signed order", nonce: "offline-nonce", publicKey: "ed25519:owner",
    signature: "offline-signature", host: "platform.test", at: new Date(now).toISOString() });
  assert.equal(claimOrderProposal(id, `limit-order:${id}`), true);
  assert.equal(saveOrderPlacement(id, { correlationId: `correlation-${requestId}`,
    orderId: `provider-${requestId}`, at: new Date(now).toISOString() }), true);
  return { id, orderId: `provider-${requestId}`, order };
}

test("partial fills stay open until a closed fill and final completed payout; failed payout is not success", () => {
  const order_id = "provider-1";
  const view = { order_id, fill_status: "partially_filled", payout_status: "in_progress",
    is_payout_status_final: false, partial_fills: [{ quantity: "100", price: "2.5" }],
    payouts: { pending: { amount: "250" } } };
  assert.equal(orderFinality(view), "open");
  assert.equal(orderFinality({ ...view, fill_status: "filled", payout_status: "completed",
    is_payout_status_final: false }), "open", "payout completion requires the provider's finality flag");
  assert.equal(orderFinality({ ...view, fill_status: "filled", payout_status: "completed",
    is_payout_status_final: true }), "complete");
  assert.equal(orderFinality({ ...view, fill_status: "canceled", payout_status: "completed",
    is_payout_status_final: true }), "complete", "a cancellation may have partial fills to pay out");
  assert.equal(orderFinality({ ...view, fill_status: "expired", payout_status: "failed",
    is_payout_status_final: true }), "failed", "a final payout failure requires review");
  assert.equal(orderFinality({ ...view, fill_status: "partially_filled", payout_status: "completed",
    is_payout_status_final: true }), "open", "partial fill is not terminal even if one payout completed");
  assert.equal(orderFinality({ ...view, fill_status: "unexpected" }), "unknown");
  assert.equal(orderFinality({ ...view, is_payout_status_final: undefined }), "unknown");
});

test("a live order read retains every fill and payout field, and a mismatched identity or terms writes no observation", async t => {
  const placed = placedOrder("observe-match");
  const partial = { order_id: placed.orderId, ...placed.order, fill_status: "partially_filled",
    payout_status: "in_progress", is_payout_status_final: false,
    partial_fills: [{ quantity: "250000", price: "2.5", fill_id: "fill-1" }],
    payouts: { "fill-1": { status: "in_progress", amount: "625000" } }, deposited_amount: "1000000" };
  let current: Record<string, unknown> = partial;
  const reads = t.mock.method(api, "getLimitOrder", async (id: string, orderId: string) => {
    assert.equal(id, AGENT);
    assert.equal(orderId, placed.orderId);
    return current as never;
  });
  assert.deepEqual(await refreshTrackedOrder(placed.id), partial);
  assert.deepEqual(readOrderObservations(placed.id).map(row => row.view), [partial]);

  current = { ...partial, order_id: "another-order" };
  await assert.rejects(refreshTrackedOrder(placed.id), /different identity or terms/);
  current = { ...partial, order_id: placed.orderId, price: "3.0" };
  await assert.rejects(refreshTrackedOrder(placed.id), /different identity or terms/);
  assert.equal(readOrderObservations(placed.id).length, 1, "unbound provider evidence is never durable");
  assert.deepEqual(await refreshOpenOrders(), [{ id: placed.id, finality: "unreadable" }]);
  assert.equal(readOrderObservations(placed.id).length, 1);
  assert.equal(reads.mock.callCount(), 4);
});

test("open orders are refreshed to payout finality; a failed payout stays visible for review", async t => {
  const placed = placedOrder("observe-finality");
  const partial = { order_id: placed.orderId, ...placed.order, fill_status: "partially_filled",
    payout_status: "in_progress", is_payout_status_final: false,
    partial_fills: [{ quantity: "250000", price: "2.5" }], payouts: { pending: "first fill" } };
  let current: Record<string, unknown> = partial;
  const reads = t.mock.method(api, "getLimitOrder", async () => current as never);
  assert.deepEqual(await refreshOpenOrders(), [{ id: placed.id, finality: "open" }]);
  assert.deepEqual(readOrderObservations(placed.id).map(row => row.view), [partial]);

  current = { ...partial, fill_status: "filled", payout_status: "completed", is_payout_status_final: true,
    partial_fills: [...partial.partial_fills, { quantity: "750000", price: "2.5" }],
    payouts: { completed: "both fills" } };
  assert.deepEqual(await refreshOpenOrders(), [{ id: placed.id, finality: "complete" }]);
  assert.deepEqual(readOrderObservations(placed.id).map(row => row.view), [partial, current]);
  assert.deepEqual(await refreshOpenOrders(), [], "durable completed payout needs no further polling");
  assert.equal(reads.mock.callCount(), 2);

  // Another order whose payout reached a final failure stays on the review path.
  const failed = placedOrder("observe-failed");
  appendOrderObservation(failed.id, { order_id: failed.orderId, fill_status: "expired",
    payout_status: "failed", is_payout_status_final: true, partial_fills: [], payouts: { failed: "retained" } });
  assert.equal(orderFinality(readOrderObservations(failed.id).at(-1)!.view), "failed");
  t.mock.method(api, "getLimitOrder", async (_id: string, orderId: string) => ({ order_id: orderId,
    fill_status: "expired", payout_status: "failed", is_payout_status_final: true,
    partial_fills: [], payouts: { failed: "retained" } }) as never);
  assert.deepEqual(await refreshOpenOrders(), [{ id: failed.id, finality: "failed" }]);
});
