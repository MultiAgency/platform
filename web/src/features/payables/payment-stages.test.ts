import assert from "node:assert/strict";
import { test } from "node:test";
import { paymentStages } from "./payment-stages.js";

const unknown = { heldEvidence: false, approved: false, rejected: false, paid: false, failed: false, isHeld: false };
test("settlement does not manufacture held or owner-approval evidence", () => {
  const stage = paymentStages({ ...unknown, paid: true, s: "SUCCESS" });
  assert.equal(stage(1), "unverified");
  assert.equal(stage(2), "unverified");
  assert.equal(stage(3), "unverified");
  assert.equal(stage(4), "complete");
});
test("a successful owner decision does not establish payment completion", () => {
  const stage = paymentStages({ ...unknown, approved: true, heldEvidence: true, isHeld: true, s: "PENDING_APPROVAL" });
  assert.equal(stage(3), "complete");
  assert.equal(stage(4), "upcoming");
});
test("an attempted owner action stays in progress and failed payment stays separate", () => {
  const stage = paymentStages({ ...unknown, recovering: { stage: "submitted" }, failed: true, s: "FAILED" });
  assert.equal(stage(3), "current");
  assert.equal(stage(4), "stopped");
});

test("a DAO proposal that ended without approval stops the vote stage instead of reading as still voting", () => {
  for (const status of ["Rejected", "Removed", "Expired"])
    assert.equal(paymentStages({ ...unknown, proposal: { status } })(2), "stopped", status);
  // Finalize can re-run a Failed proposal; a status not known to end it stays open.
  for (const status of ["InProgress", "Failed", "Moved", "Unrecognised"])
    assert.equal(paymentStages({ ...unknown, proposal: { status } })(2), "current", status);
  assert.equal(paymentStages({ ...unknown, proposal: { status: "Approved" } })(2), "complete");
});

test("a payment on its way reads as processing everywhere, as the payee's invoice reads it as paying", async () => {
  const { paymentProgress } = await import("./payment-progress.js");
  const { buildPaymentQueue } = await import("./payment-queue.js");
  for (const status of ["PROCESSING", "QUEUED", "SENT"]) {
    assert.equal(paymentProgress({ status, statusError: false, ownerError: false, approved: false, rejected: false }).outcome, "Payment processing", status);
    const [held] = buildPaymentQueue({ payments: [["c", { at: "2026-01-01T00:00:00Z" } as never]], activity: [{ correlationId: "c", idempotencyKey: "k", status }] as never });
    assert.equal(held?.reason, "Payment processing", status);
  }
});

test("a held payout is checked against its payee's newest agreed terms, as the server's termsFor picks them", async () => {
  const { termsInForce } = await import("./payment-terms.js");
  const terms = (maxAmount: string) => ({ maxAmount, until: "2030-01-01T00:00:00Z" });
  // agreements/list answers newest first.
  const listed = [
    { payee: "p.near", status: "declined", terms: terms("9") },
    { payee: "q.near", status: "agreed", terms: terms("8") },
    { payee: "p.near", status: "agreed", terms: terms("3") },
    { payee: "p.near", status: "requested" },
    { payee: "p.near", status: "filed", terms: terms("1") },
  ];
  assert.deepEqual(termsInForce(listed, "p.near"), terms("3"));
  assert.equal(termsInForce(listed, "r.near"), undefined);
});
