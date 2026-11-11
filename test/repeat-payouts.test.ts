import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, mock, test } from "node:test";
import { createRouterClient } from "@orpc/server";
import { api } from "../src/api.js";
import { canonical } from "../src/mandate.js";
import { ASSETS, payoutPolicy } from "../src/policy.js";
import { REPEAT_WINDOW_MS, repeatPayouts } from "../src/repeat-payouts.js";
import { router } from "../src/router.js";
import { authorityFixture, fixtureWallet, policyView } from "./fixtures/authority.js";
import { freshDirectory, offline } from "./fixtures/harness.js";

// A vote on a held payout says when the same payee, asset and amount were already paid recently, so an owner asked to
// approve a second payment of one invoice sees the first (docs/crash-test.md). It informs; it never refuses.

freshDirectory("repeat-payouts");
beforeEach(() => {
  process.env.AGENT_GRANT_TOKEN = "ngt_fixture";
  offline();
  for (const [name, method] of Object.entries(authorityFixture())) mock.method(api, name as keyof typeof api, method as never);
  mock.method(api, "getPolicy", async () => policyView(payoutPolicy(["payee.near"])));
});
afterEach(() => mock.restoreAll());

const NOW = Date.parse("2026-11-11T12:00:00Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const terms = { recipient: "payee.near", asset: ASSETS.USDC, amount: "2000000" };
type Entry = { correlation_id: string; agent_id: string | null; type: string; status: string; created_at: string; details: Record<string, unknown> };
const entry = (correlation_id: string, change: Partial<Entry> = {}, request: Record<string, unknown> | null = { recipient: "payee.near", asset: ASSETS.USDC, amount: "2000000" }): Entry =>
  ({ correlation_id, agent_id: process.env.AGENT_ID!, type: "transfer", status: "SUCCESS", created_at: at(30),
    details: { action: "transfer", approval_id: `approval-${correlation_id}`, ...(request && { request }) }, ...change });
const history = (...pages: Entry[][]) => mock.method(api, "getHistory", async (_agent: string, query: { cursor?: string } = {}) => {
  const index = query.cursor ? Number(query.cursor) : 0;
  return { data: pages[index] ?? [], next_cursor: index + 1 < pages.length ? String(index + 1) : null };
});

test("a settled payout of the same payee, asset and amount in the window is a repeat", async () => {
  history([entry("earlier"), entry("this one", { status: "PENDING_APPROVAL" })]);
  assert.deepEqual(await repeatPayouts(terms, "this one", NOW), { checked: true, payouts: [{ correlationId: "earlier", at: at(30), status: "SUCCESS" }] });
});

test("other terms, another agent, a refund, the vote's own payout or an older one are not repeats", async () => {
  history([
    entry("other amount", {}, { recipient: "payee.near", asset: ASSETS.USDC, amount: "2000001" }),
    entry("other payee", {}, { recipient: "payee2.near", asset: ASSETS.USDC, amount: "2000000" }),
    entry("other asset", {}, { recipient: "payee.near", asset: ASSETS.wNEAR, amount: "2000000" }),
    entry("other agent", { agent_id: "b".repeat(64) }),
    entry("refunded", { status: "REFUNDED" }),
    entry("a swap", { type: "swap" }),
    entry("this one"),
    entry("old", { created_at: new Date(NOW - REPEAT_WINDOW_MS - 60_000).toISOString() }),
  ]);
  assert.deepEqual(await repeatPayouts(terms, "this one", NOW), { checked: true, payouts: [] });
});

test("a failed payout counts, with its status: a provider FAILED isn't proof nothing moved", async () => {
  history([entry("failed", { status: "FAILED" })]);
  assert.deepEqual(await repeatPayouts(terms, "this one", NOW), { checked: true, payouts: [{ correlationId: "failed", at: at(30), status: "FAILED" }] });
});

test("an entry without its terms is read from its approval, and a held or processing one counts too", async () => {
  history([entry("held", { status: "PENDING_APPROVAL" }, null), entry("processing", { status: "PROCESSING" })]);
  const approval = mock.method(api, "getApproval", async (_agent: string, approvalId: string) =>
    ({ approval_id: approvalId, request_data: { to: "payee.near", token: ASSETS.USDC, amount: "2000000" } }));
  const found = await repeatPayouts(terms, "this one", NOW);
  assert.deepEqual(found, { checked: true, payouts: [
    { correlationId: "held", at: at(30), status: "PENDING_APPROVAL" }, { correlationId: "processing", at: at(30), status: "PROCESSING" }] });
  assert.equal(approval.mock.callCount(), 1, "only the entry without terms needs its approval");
});

test("a withdrawal and a transfer of the same amount to the same account are different payouts", async () => {
  history([entry("withdrawn", { type: "withdraw" }, { recipient: "payee.near", asset: ASSETS.USDC, amount: "2000000", chain: "near" })]);
  assert.deepEqual(await repeatPayouts(terms, "this one", NOW), { checked: true, payouts: [] });
  assert.deepEqual(await repeatPayouts({ ...terms, chain: "near" }, "this one", NOW), { checked: true, payouts: [{ correlationId: "withdrawn", at: at(30), status: "SUCCESS" }] });
});

test("a history that can't be read whole says so: it is never reported as no repeats", async () => {
  mock.method(api, "getHistory", async () => { throw new Error("down"); });
  assert.deepEqual(await repeatPayouts(terms, "this one", NOW), { checked: false });
  mock.method(api, "getHistory", async () => ({ data: [entry("x", { created_at: at(1) })], next_cursor: "again" }));
  assert.deepEqual(await repeatPayouts(terms, "this one", NOW), { checked: false }, "a page that repeats");
  history([entry("needs approval", {}, null)]);
  mock.method(api, "getApproval", async () => { throw new Error("down"); });
  assert.deepEqual(await repeatPayouts(terms, "this one", NOW), { checked: false }, "an approval that can't be read");
});

const APPROVAL = "93d2992b-84ca-4a28-b653-4cfe816c954a";
/** A held confidential transfer of `terms` waiting for the owner's vote, as the provider describes it. */
function heldPayment() {
  const data = { to: terms.recipient, token: terms.asset, amount: terms.amount };
  const request_hash = createHash("sha256").update(canonical({ ...data, chain: "near", flow: "transfer", kind: "confidential" })).digest("hex");
  mock.method(api, "getApproval", async (_agent: string, approval_id: string) => ({ approval_id, wallet_id: fixtureWallet.wallet_id, status: "PENDING",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(), request_hash, request_type: "confidential", request_data: data }));
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, agent_id: process.env.AGENT_ID, type: "transfer",
    status: "PENDING_APPROVAL", details: { approval_id: APPROVAL } }));
  mock.method(api, "generateIntent", async () => ({ correlation_id: "vote", type: "approval_vote", expires_at: new Date(Date.now() + 300_000).toISOString(),
    signer: { type: "near", account_id: "owner.near", public_key: "ed25519:key" }, intent: { standard: "nep413", payload: { message: "approve:x:k:h", recipient: "r", nonce: "n" } },
    preview: { summary: "Approve", approval: { approval_id: APPROVAL, request_hash, verdict: "approve" } } }));
  return { type: "approval_vote" as const, approvalId: APPROVAL, verdict: "approve" as const, correlationId: "op_held" };
}

test("a prepared approve vote carries the repeats beside its proven terms", async () => {
  const action = heldPayment();
  const paidAt = new Date(Date.now() - 60_000).toISOString();
  history([entry("earlier", { created_at: paidAt })]);
  const prepared = await createRouterClient(router).owner.prepare({ action, signer: "wallet" });
  assert.deepEqual(prepared.payment?.terms, terms);
  assert.deepEqual(prepared.payment?.repeats, { checked: true, payouts: [{ correlationId: "earlier", at: paidAt, status: "SUCCESS" }] });
});

test("an unreadable history doesn't stop the vote: its answer says the check couldn't be made", async () => {
  const action = heldPayment();
  mock.method(api, "getHistory", async () => { throw new Error("down"); });
  const prepared = await createRouterClient(router).owner.prepare({ action, signer: "wallet" });
  assert.deepEqual(prepared.payment?.terms, terms);
  assert.deepEqual(prepared.payment?.repeats, { checked: false });
});

test("a reject vote isn't checked for repeats: it releases nothing", async () => {
  const action = { ...heldPayment(), verdict: "reject" as const };
  mock.method(api, "generateIntent", async () => ({ correlation_id: "vote", type: "approval_vote", expires_at: new Date(Date.now() + 300_000).toISOString(),
    signer: { type: "near", account_id: "owner.near", public_key: "ed25519:key" }, intent: { standard: "nep413", payload: { message: "reject:approval:k:h", recipient: "r", nonce: "n" } },
    preview: { summary: "Reject", approval: { approval_id: APPROVAL, request_hash: (await api.getApproval("a", APPROVAL)).request_hash, verdict: "reject" } } }));
  const read = mock.method(api, "getHistory", async () => assert.fail("a reject reads no history"));
  const prepared = await createRouterClient(router).owner.prepare({ action, signer: "wallet" });
  assert.equal(prepared.payment?.repeats, undefined);
  assert.equal(read.mock.callCount(), 0);
});
