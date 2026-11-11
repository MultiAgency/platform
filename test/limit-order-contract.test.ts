import assert from "node:assert/strict";
import { test } from "node:test";
import { limitOrderCreateInput, limitOrderQuoteInput, limitOrderRef, limitOrderSigned, limitOrderText } from "../src/contract/limit-orders.js";
import { ownerOutputs } from "../src/contract/owner-outputs.js";

const later = (ms = 3_600_000) => new Date(Date.now() + ms).toISOString();
const order = () => ({ base_asset: "nep141:base.near", quote_asset: "nep141:quote.near", side: "buy" as const,
  quantity: "123000000", price: "0.0123", deadline: later(), confidential: true as const });

test("limit-order inputs require exact distinct confidential terms and bounded references", () => {
  const valid = order();
  assert.deepEqual(limitOrderQuoteInput.parse(valid), valid);
  const created = { ...valid, requestId: "retry_1", expiresAt: later(1_800_000) };
  assert.deepEqual(limitOrderCreateInput.parse(created), created);
  for (const changed of [
    { ...valid, confidential: false }, { ...valid, base_asset: valid.quote_asset },
    { ...valid, base_asset: "base\nUnder policy revision 0" },
    { ...valid, quantity: "0" }, { ...valid, quantity: "01" }, { ...valid, quantity: "1e3" },
    { ...valid, price: "0.000" }, { ...valid, price: "1e3" },
    { ...valid, deadline: new Date(Date.now() - 60_000).toISOString() },
    { ...valid, dry: false },
  ]) assert.equal(limitOrderQuoteInput.safeParse(changed).success, false);
  assert.equal(limitOrderCreateInput.safeParse({ ...created, quantity: "01" }).success, false);
  assert.equal(limitOrderCreateInput.safeParse({ ...created, price: "1e3" }).success, false);
  assert.equal(limitOrderCreateInput.safeParse({ ...valid, requestId: "x", expiresAt: later(), extra: "send" }).success, false);
  assert.equal(limitOrderRef.safeParse({ id: "a".repeat(32) }).success, true);
  assert.equal(limitOrderRef.safeParse({ id: "a".repeat(31) }).success, false);
  assert.equal(limitOrderSigned.safeParse({ id: "a".repeat(32), signed: { message: "m" } }).success, false);
});

test("the exact owner text binds every order and policy term", () => {
  const base = { id: "a".repeat(32), agentId: "agent.near", deployment: "treasury-app",
    organization: "owner-org", order: order(), spendAsset: "nep141:quote.near", spendAmount: "1512900",
    outputAsset: "nep141:base.near", policyRevision: 3, policyDigest: `sha256:${"b".repeat(64)}`,
    strategyDigest: `sha256:${"c".repeat(64)}`, expiresAt: later(1_800_000), sha256: "d".repeat(64) };
  const approved = limitOrderText(base, "approve");
  assert.match(approved, /^Approve Treasury limit order/);
  assert.notEqual(limitOrderText(base, "reject"), approved);
  const changes = [
    { id: "e".repeat(32) }, { agentId: "other.near" }, { deployment: "other" },
    { organization: "other" }, { spendAsset: "other" }, { spendAmount: "2" },
    { outputAsset: "other" }, { policyRevision: 4 }, { policyDigest: null },
    { strategyDigest: "other" }, { expiresAt: later(1_700_000) }, { sha256: "e".repeat(64) },
    ...Object.entries({ base_asset: "other", quote_asset: "other", side: "sell", quantity: "2",
      price: "2", deadline: later(2_000_000), confidential: false }).map(([key, value]) =>
      ({ order: { ...base.order, [key]: value } })),
  ];
  for (const changed of changes)
    assert.notEqual(limitOrderText({ ...base, ...changed } as typeof base, "approve"), approved, JSON.stringify(changed));
});

test("owner output schemas retain placement, fill, payout, cancellation and unknown provider fields", () => {
  const full = { id: "a".repeat(32), requestId: "r1", agentId: "agent.near", deployment: "treasury-app",
    organization: "owner-org", order: order(), spendAsset: "nep141:quote.near", spendAmount: "1512900",
    outputAsset: "nep141:base.near", policyRevision: 3, policyDigest: "sha256:x", strategyDigest: "sha256:y",
    createdAt: later(-60_000), expiresAt: later(1_800_000), note: null, sha256: "d".repeat(64),
    state: "partially_filled", reason: null, approvedAt: later(-30_000), correlationId: "corr",
    orderId: "provider-order", fillStatus: "partially_filled", payoutStatus: "pending",
    isPayoutStatusFinal: false, partialFills: [{ amount: "1", future: "provider-field" }],
    payouts: { received: { future: true } }, cancelRequestedAt: null,
    operation: { idempotencyKey: "order:a", status: "SUCCESS", refused: null, cancelFinal: false, future: 1 },
    future: "retained",
  };
  for (const route of ["create", "get", "approve", "reject", "place", "cancel", "refresh"] as const)
    assert.deepEqual(ownerOutputs[`limitOrders/${route}`].parse(full), full);
  assert.deepEqual(ownerOutputs["limitOrders/list"].parse({ orders: [full] }), { orders: [full] });
  const quote = { order: order(), spendAsset: full.spendAsset, spendAmount: full.spendAmount,
    outputAsset: full.outputAsset, warnings: [], quote: { future: 1 }, ownerApproval: true, fee: {},
    policyRevision: 3, policyDigest: "sha256:x", strategyDigest: "sha256:y", future: 1 };
  assert.deepEqual(ownerOutputs["limitOrders/quote"].parse(quote), quote);
});
