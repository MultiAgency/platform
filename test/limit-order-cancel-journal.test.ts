import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { z } from "zod";
import { acquireMoneyLock } from "../src/lock.js";
import { blocksDispatch, claimSubmission, isResolved, opsLog, readOps, record } from "../src/ops.js";
import { freshDirectory } from "./fixtures/harness.js";

freshDirectory("limit-order-cancel-journal");
beforeEach(() => { process.env.AGENT_ID = "a".repeat(64); });

const request = { orderId: "order-1", proposalId: "a".repeat(32) };
const prepare = { at: "2026-11-10T12:00:00.000Z", idempotencyKey: "limit-order:cancel:1", kind: "limit-order-cancel",
  method: "limit_order_cancel", journalVersion: 2 as const, request };
const claim = { idempotencyKey: prepare.idempotencyKey, submissionState: "SUBMISSION_ATTEMPTED" as const };
const final = { idempotencyKey: prepare.idempotencyKey, cancelFinal: true as const };
const raw = (lines: object[]) => lines.map(line => JSON.stringify(line)).join("\n") + "\n";

test("a claimed cancellation blocks new sends until a separate final-payout observation is recorded", () => {
  record(prepare as never);
  claimSubmission(prepare.idempotencyKey, request);
  assert.equal(readOps()[0]?.submissionState, "SUBMISSION_ATTEMPTED");
  assert.equal(isResolved(readOps()[0]!), false);
  assert.equal(blocksDispatch(readOps()[0]!), true);
  record(final as never);
  assert.equal(readOps()[0]?.cancelFinal, true);
  assert.equal(isResolved(readOps()[0]!), true);
  assert.equal(blocksDispatch(readOps()[0]!), false);
  assert.throws(() => record(final as never), /Invalid cancel completion/);
});

test("a cancel provider acceptance is not a final payout and cannot be folded as one", () => {
  const accepted = { idempotencyKey: prepare.idempotencyKey, correlation_id: "provider-accepted", status: "SUCCESS" };
  writeFileSync(opsLog(), raw([prepare, claim, accepted]));
  assert.throws(readOps, /Invalid operation journal.*cancel/i);
  assert.equal(readFileSync(opsLog(), "utf8"), raw([prepare, claim, accepted]), "invalid evidence stays untouched");
});

test("record refuses cancellation acceptance before append, while an unclaimed preparation is safely retired", async () => {
  record(prepare as never);
  claimSubmission(prepare.idempotencyKey, request);
  const before = readFileSync(opsLog(), "utf8");
  assert.throws(() => record({ idempotencyKey: prepare.idempotencyKey, correlation_id: "accepted", status: "SUCCESS" }),
    /acceptance is not a final payout/);
  assert.equal(readFileSync(opsLog(), "utf8"), before);
  await assert.rejects(acquireMoneyLock(), /no proven outcome/, "a claimed cancel still blocks after restart");
});

test("a cancellation preparation without its claim blocks new sends for review", async () => {
  record(prepare as never);
  await assert.rejects(acquireMoneyLock(), /earlier money action/);
  assert.equal(readOps()[0]?.submissionState, "PREPARED");
  assert.equal(isResolved(readOps()[0]!), false);
});

for (const [name, lines] of Object.entries({
  orphan: [final],
  "before claim": [prepare, final],
  "without v2 claim protocol": [{ ...prepare, journalVersion: undefined }, claim, final],
  "wrong method": [{ ...prepare, method: "swap" }, claim, final],
  "duplicate completion": [prepare, claim, final, final],
  "mixed with refusal": [prepare, claim, { ...final, refused: "no" }],
  "mixed with preparation": [prepare, claim, { ...final, request }],
  "false marker": [prepare, claim, { ...final, cancelFinal: false }],
  "refusal after completion": [prepare, claim, final, { idempotencyKey: prepare.idempotencyKey, refused: "no" }],
  "refusal after claim": [prepare, claim, { idempotencyKey: prepare.idempotencyKey, refused: "no" }],
})) test(`invalid cancellation journal (${name}) fails closed`, () => {
  const bytes = raw(lines);
  writeFileSync(opsLog(), bytes);
  assert.throws(readOps, /Invalid operation journal/);
  assert.equal(readFileSync(opsLog(), "utf8"), bytes);
});

test("a 0.5.6 reader rejects both the new method and its completion line", () => {
  // 0.5.6's preparation method enum and outcome union, pinned in sdk-v0.5.6:src/ops.ts.
  const previousMethods = z.enum(["swap", "transfer", "shield", "unshield", "withdraw", "x402"]);
  assert.equal(previousMethods.safeParse(prepare.method).success, false);
  const identity = { idempotencyKey: z.string().min(1), at: z.string().optional() };
  const previousOutcome = z.union([
    z.object({ ...identity, submissionState: z.literal("SUBMISSION_ATTEMPTED"), request: z.never().optional() }),
    z.object({ ...identity, refused: z.string().min(1), request: z.never().optional() }),
    z.object({ ...identity, correlation_id: z.string().min(1), request: z.never().optional() }),
    z.object({ ...identity, authorization: z.object({ version: z.literal(1) }), request: z.never().optional() }),
  ]);
  assert.equal(previousOutcome.safeParse(final).success, false, "old reader cannot silently discard a completion marker");
});
