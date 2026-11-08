import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "../src/api.js";
import { held } from "../src/payouts.js";
import { acquireMoneyLock, UnresolvedOperations } from "../src/lock.js";
import { readOps, record } from "../src/ops.js";
import { freshDirectory } from "./fixtures/harness.js";

freshDirectory("payout-review");

test("dashboard held-payout review cannot report empty when remote history is unavailable", async () => {
  Object.assign(api, { getHistory: async () => { throw new Error("history unavailable"); } });
  await assert.rejects(held({ complete: true }), /history unavailable/);
});

test("an approve-only copy lists a held withdrawal from the provider's history, so the owner can vote on it", async () => {
  // The approval's shape as observed on mainnet (2026-10-30, docs/enforcement.md); the vote itself is verified by checkPaymentApproval.
  const data = { to: "payee.near", chain: "near", token: "nep141:wrap.near", amount: "5", destination_asset: "nep141:wrap.near" };
  Object.assign(api, {
    getHistory: async () => ({ next_cursor: null, data: [
      { correlation_id: "op_w", agent_id: process.env.AGENT_ID, type: "withdraw", status: "PENDING_APPROVAL", created_at: new Date().toISOString(), details: { approval_id: "ap_w" } }] }),
    getApproval: async () => ({ approval_id: "ap_w", request_type: "confidential", request_data: data }),
  });
  const [listed] = await held({ complete: true });
  assert.deepEqual({ ...listed, at: undefined }, { at: undefined, kind: "remote", correlationId: "op_w", approvalId: "ap_w",
    request: { asset: "nep141:wrap.near", amount: "5", recipient: "payee.near", chain: "near", confidential: true } });
});

test("one approval that doesn't read as a payment's terms doesn't hide the other held payments", async () => {
  const good = { to: "payee.near", token: "nep141:usdc", amount: "5" };
  const odd = { to: "payee.near", token: "nep141:usdc", amount: "5.0" };
  const at = new Date().toISOString();
  Object.assign(api, {
    getHistory: async () => ({ next_cursor: null, data: [
      { correlation_id: "op_odd", agent_id: process.env.AGENT_ID, type: "transfer", status: "PENDING_APPROVAL", created_at: at, details: { approval_id: "ap_odd" } },
      { correlation_id: "op_good", agent_id: process.env.AGENT_ID, type: "transfer", status: "PENDING_APPROVAL", created_at: at, details: { approval_id: "ap_good" } }] }),
    getApproval: async (_agent: string, id: string) => ({ approval_id: id, request_type: "confidential", request_data: id === "ap_odd" ? odd : good }),
  });
  assert.deepEqual((await held({ complete: true })).map((h) => h.correlationId).sort(), ["op_good", "op_odd"]);
});

test("a held payment another agent owns isn't listed, and an approval without terms doesn't break the list", async () => {
  const at = new Date().toISOString();
  Object.assign(api, {
    getHistory: async () => ({ next_cursor: null, data: [
      { correlation_id: "op_other", agent_id: "another-agent", type: "withdraw", status: "PENDING_APPROVAL", created_at: at, details: { approval_id: "ap_other" } },
      { correlation_id: "op_bare", agent_id: process.env.AGENT_ID, type: "withdraw", status: "PENDING_APPROVAL", created_at: at, details: { approval_id: "ap_bare" } }] }),
    getApproval: async (_agent: string, id: string) => ({ approval_id: id, request_type: "confidential" }),
  });
  assert.deepEqual((await held({ complete: true })).map((h) => h.correlationId), ["op_bare"]);
});

test("an empty page that still names a next page is followed, so a held payment on the next page is listed", async () => {
  const at = new Date().toISOString();
  Object.assign(api, {
    getHistory: async (_agent: string, { cursor }: { cursor?: string }) => cursor
      ? { next_cursor: null, data: [{ correlation_id: "op_p2", agent_id: process.env.AGENT_ID, type: "transfer", status: "PENDING_APPROVAL", created_at: at, details: { approval_id: "ap_p2" } }] }
      : { next_cursor: "c1", data: [] },
    getApproval: async (_agent: string, id: string) => ({ approval_id: id, request_type: "confidential", request_data: { to: "payee.near", token: "nep141:usdc", amount: "5" } }),
  });
  assert.deepEqual((await held({ complete: true })).map((h) => h.correlationId), ["op_p2"]);
});

test("a history whose next page repeats doesn't loop: the held list is incomplete and says so", async () => {
  Object.assign(api, { getHistory: async () => ({ next_cursor: "same", data: [] }) });
  await assert.rejects(held({ complete: true }), /incomplete/);
});

for (const status of ["PROCESSING", "QUEUED"]) test(`a released payout observed as ${status} blocks another money action`, async () => {
  record({ at: new Date().toISOString(), idempotencyKey: "payout:held", kind: "payout", method: "transfer", journalVersion: 2,
    request: { asset: "fixture-asset", amount: "1", recipient: "payee.near", confidential: true } });
  record({ idempotencyKey: "payout:held", submissionState: "SUBMISSION_ATTEMPTED" });
  record({ idempotencyKey: "payout:held", correlation_id: "held-operation", status: "PENDING_APPROVAL" });
  Object.assign(api, {
    getStatus: async (correlation_id: string) => ({ correlation_id, agent_id: process.env.AGENT_ID, status }),
    getHistory: async () => ({ data: [], next_cursor: null }),
  });

  assert.deepEqual(await held({ complete: true }), []);
  assert.equal(readOps()[0]?.status, status, "the latest observed state must replace the held-payout exemption");
  await assert.rejects(acquireMoneyLock(), UnresolvedOperations);
});
