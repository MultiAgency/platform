import { temporaryDirectories } from "./fixtures/harness.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { dispatch } from "../src/agent.js";
import { api } from "../src/api.js";
import { prepareInvoice } from "../src/invoice-store.js";
import { file, mine } from "../src/invoices.js";
import { acquireMoneyLock, UnresolvedOperations } from "../src/lock.js";
import { canonical } from "../src/mandate.js";
import { readOps } from "../src/ops.js";
import { checkPaymentApproval } from "../src/payment-approval.js";
import { ASSETS, payoutPolicy } from "../src/policy.js";
import { recover } from "../src/recover.js";
import { prepare, submit } from "../src/owner-intents.js";
import { authorityFixture, fixtureGrant, policyView } from "./fixtures/authority.js";
import { walletIntent, walletSignature, walletSigner } from "./fixtures/wallet-signature.js";

const scratch = temporaryDirectories();

/**
 * The deployed shape: the executor (Railway) files and holds a payout from its own data directory;
 * the owner's dashboard runs elsewhere with EXECUTOR=off and its own, empty directory. They share
 * nothing but the provider.
 */
const home = process.cwd();
const invoice = { payee: "alice.near", amount: "1000000", note: "Work", submission: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
const terms = { to: invoice.payee, token: ASSETS.USDC, amount: invoice.amount };
const requestHash = createHash("sha256").update(canonical({ ...terms, chain: "near", flow: "transfer", kind: "confidential" })).digest("hex");
const vote = { type: "approval_vote" as const, approvalId: "approval", correlationId: "payment", verdict: "approve" as const };
let executor: string, dashboard: string, sends: number, signatures: number, released: boolean;
/** Acts as the approve-only dashboard (EXECUTOR=off), in its own working directory. */
function onDashboard() {
  process.chdir(dashboard);
  process.env.EXECUTOR = "off";
}

beforeEach(() => {
  executor = scratch.create("executor");
  dashboard = scratch.create("dashboard");
  process.env.AGENT_ID = "a".repeat(64);
  process.env.AGENT_GRANT_TOKEN = "ngt_test";
  sends = signatures = 0;
  released = false;
  mock.method(globalThis, "fetch", async () => { throw new Error("offline only"); });
  for (const [name, method] of Object.entries(authorityFixture())) mock.method(api, name as keyof typeof api, method as never);
  mock.method(api, "listGrants", async () => [fixtureGrant("invoices")]);
  mock.method(api, "getPolicy", async () => policyView(payoutPolicy([invoice.payee])));
  mock.method(api, "forGrant", () => ({ transfer: async () => { sends++; return { correlation_id: "payment" }; } }));
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, agent_id: process.env.AGENT_ID, type: "transfer",
    status: released ? "SUCCESS" : "PENDING_APPROVAL", details: { approval_id: "approval" } }));
  mock.method(api, "getApproval", async () => ({ approval_id: "approval", wallet_id: "wallet-fixture", status: "PENDING",
    expires_at: new Date(Date.now() + 60_000).toISOString(), request_type: "confidential", request_data: terms, request_hash: requestHash }));
  mock.method(api, "generateIntent", async () => ({ type: "approval_vote", correlation_id: "vote-1", expires_at: new Date(Date.now() + 60_000).toISOString(),
    preview: { approval: { approval_id: "approval", request_hash: requestHash, verdict: "approve" } }, intent: walletIntent, signer: walletSigner }));
  mock.method(api, "submitIntent", async () => { signatures++; released = true; return { status: "SUCCESS" }; });
});
afterEach(() => {
  mock.restoreAll();
  delete process.env.EXECUTOR;
  process.chdir(home);
});

test("the executor holds a payout, an approve-only dashboard approves it from provider evidence, and it settles", async () => {
  process.chdir(executor);
  const filed = await file(invoice, invoice.payee);
  assert.equal(filed.status, "waiting");
  assert.equal(sends, 1);

  onDashboard();
  const checked = await checkPaymentApproval(vote);
  assert.equal(checked.binding.key, undefined, "the dashboard never saw the payment sent");
  assert.equal(checked.binding.requestHash, requestHash);
  await submit((await prepare(vote)).correlationId, await walletSignature());
  assert.equal(signatures, 1);
  assert.equal(existsSync(join(dashboard, ".invoices")), false, "the dashboard keeps no payment records");

  process.chdir(executor);
  delete process.env.EXECUTOR;
  await recover();
  assert.equal((await mine(invoice.payee))[0]?.status, "paid");
  assert.equal(sends, 1, "approval released the held payment; nothing was sent again");
});

test("an approval whose terms don't hash to the provider's request is refused", async () => {
  onDashboard();
  mock.method(api, "getApproval", async () => ({ approval_id: "approval", wallet_id: "wallet-fixture", status: "PENDING",
    expires_at: new Date(Date.now() + 60_000).toISOString(), request_type: "confidential", request_data: { ...terms, amount: "9000000" }, request_hash: requestHash }));
  await assert.rejects(checkPaymentApproval(vote), /request hash/);
});

for (const [name, terms, reason] of [
  ["a payee outside the policy", { to: "stranger.near", token: ASSETS.USDC, amount: "1000000" }, /payee_not_agreed/],
  ["an amount over the per-transaction limit", { to: invoice.payee, token: ASSETS.USDC, amount: "26000000" }, /per_transaction_exceeded/],
  ["an asset outside the policy", { to: invoice.payee, token: ASSETS.wNEAR, amount: "1000000" }, /transfer_not_allowed/],
] as const) test(`approving ${name} is refused, even when the provider's hash matches`, async () => {
  onDashboard();
  const hash = createHash("sha256").update(canonical({ ...terms, chain: "near", flow: "transfer", kind: "confidential" })).digest("hex");
  mock.method(api, "getApproval", async () => ({ approval_id: "approval", wallet_id: "wallet-fixture", status: "PENDING",
    expires_at: new Date(Date.now() + 60_000).toISOString(), request_type: "confidential", request_data: terms, request_hash: hash }));
  await assert.rejects(checkPaymentApproval(vote), reason);
  assert.equal(sends, 0, "invalid approval terms cannot send a payment");
  assert.equal(signatures, 0, "invalid approval terms cannot submit an owner signature");
});

test("approval terms the provider doesn't fully expose are refused, not trusted", async () => {
  process.chdir(dashboard);
  mock.method(api, "getApproval", async () => ({ approval_id: "approval", wallet_id: "wallet-fixture", status: "PENDING",
    expires_at: new Date(Date.now() + 60_000).toISOString(), request_type: "confidential", request_data: { to: invoice.payee }, request_hash: requestHash }));
  await assert.rejects(checkPaymentApproval(vote), /incomplete/);
});

test("an invoices grant only transfers: a swap is refused before it reaches the provider", async () => {
  process.chdir(executor);
  mock.method(api, "forGrant", () => ({ swap: async () => assert.fail("must not send") }));
  const swap = { method: "swap" as const, request: { origin_asset: ASSETS.USDC, destination_asset: ASSETS.wNEAR, amount: "1000000", min_amount_out: "1", confidential: true } };
  const lock = await acquireMoneyLock();
  try {
    await assert.rejects(dispatch(lock, "swap", swap), /grant_purpose_denied/);
  } finally {
    await lock.release();
  }
  assert.equal(readOps().at(-1)?.refused, "grant_purpose_denied");
});

test("a frozen policy is refused before anything reaches the provider", async () => {
  process.chdir(executor);
  mock.method(api, "forGrant", () => ({ transfer: async () => assert.fail("must not send") }));
  mock.method(api, "getPolicy", async () => policyView({ ...payoutPolicy([invoice.payee]), frozen: true }));
  const transfer = { method: "transfer" as const, request: { asset: ASSETS.USDC, amount: "1000000", recipient: invoice.payee, confidential: true } };
  const lock = await acquireMoneyLock();
  try {
    await assert.rejects(dispatch(lock, "payout", transfer), /policy_not_in_force/);
  } finally {
    await lock.release();
  }
});

test("a prepared invoice never blocks other money actions", async () => {
  process.chdir(executor);
  // As left by a crash between preparing and submitting: never sent, so it can't have an outcome.
  prepareInvoice(invoice, ASSETS.USDC);
  const lock = await acquireMoneyLock();
  await lock.release();
});

test("an attempted invoice whose outcome is unknown still blocks new sends", async () => {
  process.chdir(executor);
  // The provider may have received it: the response was lost, so the outcome is unknown.
  mock.method(api, "forGrant", () => ({ transfer: async () => { sends++; throw new Error("socket hang up"); } }));
  assert.equal((await file(invoice, invoice.payee)).status, "unknown");
  assert.equal(sends, 1);
  await assert.rejects(acquireMoneyLock(), UnresolvedOperations);
  // Refiling the same form never sends again.
  assert.equal((await file(invoice, invoice.payee)).status, "unknown");
  assert.equal(sends, 1);
});

test("an approve-only instance never sends", async () => {
  onDashboard();
  const lock = await acquireMoneyLock();
  try {
    await assert.rejects(dispatch(lock, "payout", { method: "transfer", request: { asset: ASSETS.USDC, amount: "1", recipient: invoice.payee, confidential: true } }), /only approves/);
  } finally {
    await lock.release();
  }
  assert.equal(sends, 0);
});

const withPolicy = (change: (policy: ReturnType<typeof payoutPolicy>) => object, view: object = {}) =>
  mock.method(api, "getPolicy", async () => ({ ...policyView({ ...payoutPolicy([invoice.payee]), ...change(payoutPolicy([invoice.payee])) }), ...view }));

for (const [name, change] of Object.entries({
  "assets any": () => ({ assets: "any" }),
  "no per-transaction cap": (p: ReturnType<typeof payoutPolicy>) => ({ limits: { ...p.limits, per_transaction: undefined } }),
})) test(`approval is allowed under ${name}`, async () => {
  onDashboard();
  withPolicy(change);
  assert.equal((await checkPaymentApproval(vote)).binding.requestHash, requestHash);
});

for (const [name, setup, reason] of [
  ["a payee in an except list", () => withPolicy(() => ({ destinations: { mode: "except", list: [{ action: "transfer", address: invoice.payee, confidential: true }] } })), /payee_not_agreed/],
  // An except list agrees to no one.
  ["a policy that sends anywhere", () => withPolicy(() => ({ destinations: { mode: "any", list: [] } })), /payee_not_agreed/],
  ["a payee an except list doesn't exclude", () => withPolicy(() => ({ destinations: { mode: "except", list: [{ action: "transfer", address: "other.near", confidential: true }] } })), /payee_not_agreed/],
  ["a frozen policy", () => withPolicy(() => ({ frozen: true })), /policy_not_in_force/],
  ["an unapplied policy", () => withPolicy(() => ({}), { status: "PENDING" }), /policy_not_in_force/],
  ["an unsynced policy", () => withPolicy(() => ({}), { provider_policy_synced: false }), /policy_not_in_force/],
  ["owner approval switched off", () => withPolicy(() => ({ owner_approval: false })), /owner_approval_required/],
  ["an expired approval", () => mock.method(api, "getApproval", async () => ({ approval_id: "approval", wallet_id: "wallet-fixture", status: "PENDING",
    expires_at: new Date(Date.now() - 1).toISOString(), request_type: "confidential", request_data: terms, request_hash: requestHash })), /does not identify/],
  ["an approval for another execution", () => mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, agent_id: process.env.AGENT_ID,
    type: "transfer", status: "PENDING_APPROVAL", details: { approval_id: "other" } })), /does not identify/],
] as const) test(`approval is refused for ${name}`, async () => {
  onDashboard();
  setup();
  await assert.rejects(checkPaymentApproval(vote), reason);
});

test("a policy change between preparing and submitting an approval invalidates it", async () => {
  onDashboard();
  const prepared = await prepare(vote);
  withPolicy(() => ({ max_actions_per_hour: 9 }));
  await assert.rejects(submit(prepared.correlationId, await walletSignature()), /binding changed/);
  assert.equal(signatures, 0);
});

test("a prepared vote names the payout it releases and, for approve, the terms proven against the provider's hash", async () => {
  onDashboard();
  const approve = await prepare(vote);
  assert.deepEqual(approve.payment, { correlationId: "payment", verdict: "approve", terms: { recipient: invoice.payee, asset: ASSETS.USDC, amount: invoice.amount } });
  mock.method(api, "generateIntent", async () => ({ type: "approval_vote", correlation_id: "vote-2", expires_at: new Date(Date.now() + 60_000).toISOString(),
    preview: { approval: { approval_id: "approval", request_hash: requestHash, verdict: "reject" } }, intent: walletIntent, signer: walletSigner }));
  assert.deepEqual((await prepare({ ...vote, verdict: "reject" })).payment, { correlationId: "payment", verdict: "reject", terms: null },
    "a reject proves no terms: rejecting releases nothing");
});

test("rejecting needs only the identity checks: no policy or agent reads", async () => {
  onDashboard();
  mock.method(api, "getPolicy", async () => assert.fail("reject must not read policy"));
  mock.method(api, "getAgent", async () => assert.fail("reject must not read the agent"));
  assert.equal((await checkPaymentApproval({ ...vote, verdict: "reject" })).binding.verdict, "reject");
});

test("a status read that fails says nothing about a held invoice: it stays waiting and blocks nothing", async () => {
  process.chdir(executor);
  assert.equal((await file(invoice, invoice.payee)).status, "waiting");
  mock.method(api, "getStatus", async () => { throw new Error("rate_limited"); });
  assert.equal((await mine(invoice.payee))[0]?.status, "waiting", "the payee's page read failed; the payment didn't change");
  await recover();
  assert.equal((await mine(invoice.payee))[0]?.status, "waiting");
  const lock = await acquireMoneyLock();
  await lock.release();
});

test("a status read naming another operation isn't a mere read failure: the invoice becomes unknown", async () => {
  process.chdir(executor);
  assert.equal((await file(invoice, invoice.payee)).status, "waiting");
  mock.method(api, "getStatus", async () => ({ correlation_id: "someone-else", agent_id: process.env.AGENT_ID, status: "SUCCESS" }));
  assert.equal((await mine(invoice.payee))[0]?.status, "unknown");
});

for (const [name, change] of [
  ["USDC removed", { assets: [ASSETS.wNEAR] }],
  ["transfers disabled", { actions: [] }],
] as const) test(`approval refuses a current policy with ${name}`, async () => {
  onDashboard();
  withPolicy(() => change);
  await assert.rejects(checkPaymentApproval(vote), /asset_not_allowed|action_not_allowed/);
  assert.equal(signatures, 0);
});

for (const verdict of ["approve", "reject"] as const) test(`${verdict} refuses a status response naming another payment`, async () => {
  onDashboard();
  mock.method(api, "getStatus", async () => ({ correlation_id: "other-payment", agent_id: process.env.AGENT_ID,
    type: "transfer", status: "PENDING_APPROVAL", details: { approval_id: "approval" } }));
  await assert.rejects(checkPaymentApproval({ ...vote, verdict }), /another operation|identify/);
  assert.equal(signatures, 0);
});

// Remove state only after this suite has released its locks and stopped its processes.
after(scratch.cleanup);
