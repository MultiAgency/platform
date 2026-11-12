import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { canonicalRecord } from "../src/mandate.js";
import { loadProposal, proposalIdOf, proposalIds, saveProposal, type ProposalRecord } from "../src/proposals/store.js";
import { appendOrderObservation, claimOrderCancellation, claimOrderProposal, closeOrderProposal, loadOrderProposal,
  orderProposalIdOf, orderProposalIds, readOrderApproval, readOrderCancellation, readOrderFinal, readOrderObservations,
  readOrderPlacement, saveOrderApproval, saveOrderPlacement, saveOrderProposal, type OrderProposalRecord } from "../src/limit-orders/store.js";
import { freshDirectory } from "./fixtures/harness.js";

const AGENT = "a".repeat(64);
const OTHER_AGENT = "b".repeat(64);
const ACTOR = "app:treasury:org_1";
const CONSENT = "c".repeat(64);
const START = "2026-11-10T12:00:00.000Z";
const END = "2026-11-11T12:00:00.000Z";
const DEADLINE = "2026-11-12T12:00:00.000Z";
const DIGEST = `sha256:${"d".repeat(64)}`;

freshDirectory("limit-order-store");
beforeEach(() => { process.env.AGENT_ID = AGENT; });

function record(requestId = "r1"): OrderProposalRecord {
  return {
    version: 1, id: orderProposalIdOf(ACTOR, requestId), requestId, actor: ACTOR, consent: CONSENT,
    deployment: "treasury", organization: "org_1", agentId: AGENT,
    order: { base_asset: "base", quote_asset: "quote", side: "sell", quantity: "42", price: "2.5", deadline: DEADLINE, confidential: true },
    spendAsset: "base", spendAmount: "42", outputAsset: "quote",
    policyRevision: 2, policyDigest: DIGEST, strategyDigest: DIGEST,
    createdAt: START, expiresAt: END, note: "place at the agreed price",
  };
}
const approval = { message: "approve exact order", nonce: "nonce", publicKey: "ed25519:key", signature: "signature", host: "platform.test", at: START };
const closed = { state: "rejected" as const, reason: "owner rejected", at: START };
const pathFor = (id: string, suffix = ".json") => join(".proposals", "limit-orders", AGENT, `${id}${suffix}`);

test("an order proposal is immutable, hashed over its exact terms, and isolated by agent", () => {
  const value = record();
  assert.equal(saveOrderProposal(value), true);
  const saved = loadOrderProposal(value.id)!;
  assert.deepEqual(saved.record, value);
  assert.equal(saved.sha256, createHash("sha256").update(canonicalRecord(value)).digest("hex"));
  assert.deepEqual(orderProposalIds(), [value.id]);
  assert.equal(saveOrderProposal(value), false);
  assert.equal(saveOrderProposal({ ...value, note: "different" }), false, "a reused request identity never replaces the signed terms");
  assert.deepEqual(loadOrderProposal(value.id)!.record, value);
  process.env.AGENT_ID = OTHER_AGENT;
  assert.deepEqual(orderProposalIds(), []);
  assert.equal(loadOrderProposal(value.id), null);
  process.env.AGENT_ID = AGENT;
  assert.throws(() => loadOrderProposal("../other"), /Invalid limit-order proposal id/);
});

test("owner approval and the final close or claim are durable, one-way records", () => {
  const first = record();
  saveOrderProposal(first);
  assert.throws(() => claimOrderProposal(first.id, "op-1"), /no owner approval/);
  assert.equal(saveOrderApproval(first.id, approval), true);
  assert.equal(saveOrderApproval(first.id, approval), false);
  assert.throws(() => saveOrderApproval(first.id, { ...approval, signature: "different" }), /conflicting owner approval evidence/);
  assert.deepEqual(readOrderApproval(first.id), approval);
  assert.equal(claimOrderProposal(first.id, "op-1"), true);
  assert.equal(claimOrderProposal(first.id, "op-1"), false);
  assert.equal(closeOrderProposal(first.id, closed), false);
  assert.deepEqual(readOrderFinal(first.id), { state: "claimed", operationKey: "op-1", at: readOrderFinal(first.id)!.at });

  const second = record("r2");
  saveOrderProposal(second);
  assert.equal(closeOrderProposal(second.id, closed), true);
  assert.equal(saveOrderApproval(second.id, approval), false);
  assert.equal(claimOrderProposal(second.id, "op-2"), false);
  assert.deepEqual(readOrderFinal(second.id), closed);
  assert.throws(() => saveOrderPlacement(second.id, { correlationId: "c2", orderId: "o2", at: START }), /not claimed/);
});

test("placement, full provider observations, and cancellation claim survive reads without inventing a final payout", () => {
  const value = record();
  saveOrderProposal(value);
  saveOrderApproval(value.id, approval);
  claimOrderProposal(value.id, "op-1");
  const placed = { correlationId: "correlation-1", orderId: "order-1", at: START };
  assert.equal(saveOrderPlacement(value.id, placed), true);
  assert.equal(saveOrderPlacement(value.id, placed), false);
  assert.equal(saveOrderPlacement(value.id, { ...placed, at: END }), false,
    "a later recovery read of the same provider identity keeps the first timestamp");
  assert.throws(() => saveOrderPlacement(value.id, { ...placed, orderId: "order-2" }), /conflicting placement evidence/);
  assert.deepEqual(readOrderPlacement(value.id), placed);

  const partial = { order_id: placed.orderId, fill_status: "PARTIALLY_FILLED", payout_status: "PENDING",
    is_payout_status_final: false, partial_fills: [{ quantity: "10", price: "2.5" }], payouts: { pending: "one" }, deposited_amount: "42" };
  appendOrderObservation(value.id, partial, START);
  assert.equal(appendOrderObservation(value.id, partial, END), false,
    "an unchanged provider view does not add a row at every reconciliation tick");
  const final = { ...partial, fill_status: "FILLED", payout_status: "PAID", is_payout_status_final: true,
    partial_fills: [...partial.partial_fills, { quantity: "32", price: "2.5" }], payouts: { paid: "two" } };
  appendOrderObservation(value.id, final, END);
  assert.deepEqual(readOrderObservations(value.id), [{ at: START, view: partial }, { at: END, view: final }]);
  assert.throws(() => appendOrderObservation(value.id, { ...partial, order_id: "other" }), /another limit order/);

  assert.equal(claimOrderCancellation(value.id, placed.orderId), true);
  assert.equal(claimOrderCancellation(value.id, placed.orderId), false, "a lost cancellation answer cannot authorize replay");
  assert.equal(readOrderCancellation(value.id)?.orderId, placed.orderId);
  assert.throws(() => claimOrderCancellation(value.id, "other"), /no matching placement/);
});

test("damaged proposal and torn observation history fail closed before another append", () => {
  const value = record();
  saveOrderProposal(value);
  saveOrderApproval(value.id, approval);
  claimOrderProposal(value.id, "op-1");
  saveOrderPlacement(value.id, { correlationId: "c1", orderId: "o1", at: START });
  appendOrderObservation(value.id, { order_id: "o1", fill_status: "OPEN", partial_fills: [], payouts: null }, START);
  const log = pathFor(value.id, ".observations.jsonl");
  appendFileSync(log, '{"at":"incomplete'); // a process died during the next append
  assert.throws(() => readOrderObservations(value.id), /Invalid record.*history unavailable/);
  assert.throws(() => appendOrderObservation(value.id,
    { order_id: "o1", fill_status: "PARTIALLY_FILLED", partial_fills: [{}], payouts: null }, END),
  /Invalid record.*history unavailable/);
  assert.equal(readFileSync(log, "utf8").split("\n").filter(Boolean).length, 2,
    "a damaged history cannot silently accumulate newer observations");
  assert.throws(() => readOrderObservations(value.id), /Invalid record.*history unavailable/, "do not skip missing evidence");

  const saved = JSON.parse(readFileSync(pathFor(value.id), "utf8")) as { proposal: OrderProposalRecord; sha256: string };
  saved.proposal.order.quantity = "43";
  writeFileSync(pathFor(value.id), JSON.stringify(saved));
  assert.throws(() => loadOrderProposal(value.id), /changed or misplaced/);
  assert.throws(() => orderProposalIds(), /changed or misplaced/, "listing cannot hide a corrupt proposal");
});

test("listing refuses orphan lifecycle evidence rather than hiding it", () => {
  const value = record();
  saveOrderProposal(value);
  const orphan = "e".repeat(32);
  writeFileSync(pathFor(orphan, ".final.json"), JSON.stringify({ state: "claimed", operationKey: "op", at: START }));
  assert.throws(() => orderProposalIds(), /Orphan limit-order state/);
  assert.throws(() => readOrderFinal(orphan), /missing; preserve state/);
});

test("the unchanged 0.5.6 Treasury proposal reader ignores nested orders and keeps its earlier record readable", () => {
  const requestId = "prior";
  const id = proposalIdOf(ACTOR, requestId);
  const prior: ProposalRecord = { version: 1, id, requestId, actor: ACTOR, consent: CONSENT, deployment: "treasury", organization: "org_1",
    agentId: AGENT, source: "external", request: { legs: [{ from: "base", to: "quote", amount: "1" }] },
    legs: [{ from: "base", to: "quote", amount: "1", minAmountOut: "1" }], quoted: [{ amountOut: "1", costBps: 0, usdIn: 1 }],
    policyRevision: 2, policyDigest: DIGEST, strategyDigest: DIGEST, createdAt: START, expiresAt: END, note: null };
  assert.equal(saveProposal(prior), true);
  const oldPath = join(".proposals", AGENT, `${id}.json`);
  const before = readFileSync(oldPath, "utf8");
  const order = record();
  assert.equal(saveOrderProposal(order), true);
  assert.deepEqual(proposalIds(), [id], "the 0.5.6 reader never interprets an order proposal as a swap proposal");
  assert.deepEqual(orderProposalIds(), [order.id], "the order reader never interprets an earlier swap proposal as an order");
  assert.deepEqual(loadProposal(id)?.record, prior);
  assert.equal(readFileSync(oldPath, "utf8"), before, "new state creation did not modify earlier proposal files");
});
