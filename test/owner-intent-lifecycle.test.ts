import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { freshDirectory } from "./fixtures/harness.js";

freshDirectory("owner-intent-lifecycle");

test("every view of an owner intent closes its signing window at the moment submission is refused", async t => {
  const { daoRequests, ownerActions, status } = await import("../src/owner-intents.js");
  const closes = Date.parse("2030-01-01T00:00:00.000Z");
  const dao = { owner: { account_id: "dao-owner.near" }, hash: "00", intent: {} };
  mkdirSync(".owner-intents", { recursive: true });
  writeFileSync(".owner-intents/.env.json", JSON.stringify({
    vote: { type: "agent_freeze", stage: "prepared", expiresAt: new Date(closes).toISOString(), dao } }));
  t.mock.method(Date, "now", () => closes);
  assert.equal(ownerActions(closes)[0]?.stage, "expired");
  assert.equal(daoRequests(closes)[0]?.state, "expired");
  assert.equal(status("vote").stage, "expired");
  // A millisecond before, every view still has it open.
  assert.equal(ownerActions(closes - 1)[0]?.stage, "prepared");
  assert.equal(daoRequests(closes - 1)[0]?.state, "waiting");
});

test("each view names the same phase for an owner action, whatever its own stage word", async t => {
  const { daoRequests, ownerActions, status } = await import("../src/owner-intents.js");
  const { ownerActionsOutput, ownerPendingOutput, ownerStatusOutput } = await import("../src/contract/owner-outputs.js");
  const now = Date.parse("2030-01-01T00:00:00.000Z");
  const at = (offset: number) => new Date(now + offset).toISOString();
  const dao = { owner: { account_id: "dao-owner.near" }, hash: "00", intent: { standard: "nep413", payload: { message: "m", recipient: "r", nonce: "n" } } };
  mkdirSync(".owner-intents", { recursive: true });
  writeFileSync(".owner-intents/.env.json", JSON.stringify({
    open: { type: "agent_freeze", stage: "prepared", expiresAt: at(60_000), dao },
    closed: { type: "agent_freeze", stage: "prepared", expiresAt: at(-1), dao },
    sent: { type: "agent_freeze", stage: "submitted", expiresAt: at(60_000), dao, signedData: {} },
    done: { type: "agent_freeze", stage: "settled", expiresAt: at(-60_000), dao, signedData: {}, result: { status: "SUCCESS" } },
  }));
  t.mock.method(Date, "now", () => now);
  const expected = { open: "open", closed: "expired", sent: "submitted", done: "settled" };
  const actions = ownerActionsOutput.parse(ownerActions(now)), pending = ownerPendingOutput.parse(daoRequests(now));
  for (const [id, phase] of Object.entries(expected)) {
    assert.equal(actions.find(a => a.correlationId === id)?.phase, phase, `actions ${id}`);
    assert.equal(pending.find(p => p.correlationId === id)?.phase, phase, `pending ${id}`);
    assert.equal(ownerStatusOutput.parse(status(id)).phase, phase, `status ${id}`);
  }
  assert.equal(ownerStatusOutput.parse(status("never-prepared")).phase, undefined);
});

test("an expired wallet intent still reads expired once the lock has dropped its record", async t => {
  const { reconcileOwnerIntents, status } = await import("../src/owner-intents.js");
  const { readFileSync } = await import("node:fs");
  mkdirSync(".owner-intents", { recursive: true });
  writeFileSync(".owner-intents/.env.json", JSON.stringify({ lapsed: { type: "grant_issue", stage: "prepared", expiresAt: new Date(Date.now() - 1_000).toISOString() } }));
  assert.deepEqual([status("lapsed").stage, status("lapsed").phase], ["expired", "expired"]);
  await reconcileOwnerIntents();
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(".owner-intents/.env.json", "utf8"))), [], "dropped");
  assert.deepEqual([status("lapsed").stage, status("lapsed").phase], ["expired", "expired"]);
  void t;
});
