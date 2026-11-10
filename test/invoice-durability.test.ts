import { authorityFixture, policyView } from "./fixtures/authority.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, test } from "node:test";
import { AgentApiError } from "@near-intents-agent-api/sdk";
import { api } from "../src/api.js";
import { file, mine } from "../src/invoices.js";
import { cancelPreparedInvoice, claimInvoiceSubmission, getInvoice, invoiceDatabasePath, invoiceId, listInvoices, markInvoiceUnknown, prepareInvoice } from "../src/invoice-store.js";
import { acquireMoneyLock, UnresolvedOperations } from "../src/lock.js";
import { pay } from "../src/agent.js";
import { readOps, record } from "../src/ops.js";
import { ASSETS, payoutPolicy } from "../src/policy.js";
import { PublicError } from "../src/public-error.js";
import { recover } from "../src/recover.js";
import { freshDirectory, TSX } from "./fixtures/harness.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/invoice-crash.ts", import.meta.url));
const invoice = { payee: "alice.near", amount: "1000000", note: "October", submission: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
let sends: string[];
freshDirectory("invoice-durability");
beforeEach(() => {
  process.env.AGENT_GRANT_TOKEN = "ngt_test";
  sends = [];
  Object.assign(api, {
    ...authorityFixture(),
    getPolicy: async () => policyView(payoutPolicy([invoice.payee])),
    forGrant: () => ({ transfer: async (_id: string, _request: unknown, { idempotencyKey }: { idempotencyKey: string }) => {
      sends.push(idempotencyKey); return { correlation_id: "op_invoice" };
    } }),
    getStatus: async (correlation_id: string) => ({ correlation_id, status: "PENDING_APPROVAL", details: { approval_id: "approval" } }),
  });
});
const stored = () => getInvoice(invoiceId(invoice))!;

test("concurrent copies produce one occurrence, operation, immutable request and reservation", async () => {
  const outcomes = await Promise.all(Array.from({ length: 20 }, () => file(invoice, invoice.payee)));
  assert.deepEqual(new Set(outcomes.map((r) => r.id)), new Set([invoiceId(invoice)]));
  assert.ok(outcomes.every((r) => r.status === "waiting"));
  assert.equal(listInvoices().length, 1);
  assert.equal(readOps().length, 1);
  assert.deepEqual(sends, [stored().operation.idempotencyKey]);
  assert.equal(stored().reservation, invoice.amount);
  assert.deepEqual(stored().operation.request, { asset: ASSETS.USDC, amount: invoice.amount, recipient: invoice.payee, confidential: true });
});

test("failure inserting a reservation rolls the entire preparation back", () => {
  listInvoices();
  const db = new DatabaseSync(invoiceDatabasePath());
  db.exec("CREATE TRIGGER reservation_failure BEFORE INSERT ON reservations BEGIN SELECT RAISE(ABORT, 'disk simulation'); END;");
  db.close();
  assert.throws(() => prepareInvoice(invoice, ASSETS.USDC), /disk simulation/);
  assert.equal(listInvoices().length, 0);
  assert.deepEqual(readOps(), []);
  assert.deepEqual(sends, []);
});

test("a revision is recorded for review without changing or duplicating the payment", async () => {
  await file(invoice, invoice.payee);
  const first = stored();
  const result = await file({ ...invoice, amount: "2000000", note: "Correction" }, invoice.payee);
  assert.equal(result.status, "needs_review");
  assert.equal(result.revisionConflict, true);
  assert.equal(stored().amount, invoice.amount);
  assert.equal(stored().operation.idempotencyKey, first.operation.idempotencyKey);
  assert.equal(stored().reservation, invoice.amount);
  const db = new DatabaseSync(invoiceDatabasePath());
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM revisions").get() as { n: number }).n, 2);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM payments").get() as { n: number }).n, 1);
  db.close();
  assert.equal(sends.length, 1);
});

test("a revision before submission blocks the original prepared payment too", async () => {
  prepareInvoice(invoice, ASSETS.USDC);
  await file({ ...invoice, amount: "2" }, invoice.payee);
  assert.equal((await file(invoice, invoice.payee)).status, "needs_review");
  assert.equal(sends.length, 0);
  assert.equal(stored().operation.submissionState, "PREPARED");
});

test("unknown has no second send, keeps its reservation, and blocks ordinary dashboard payments", async () => {
  Object.assign(api, { forGrant: () => ({ transfer: async (_id: string, _request: unknown, { idempotencyKey }: { idempotencyKey: string }) => {
    sends.push(idempotencyKey); throw new Error("response lost after acceptance");
  } }) });
  assert.equal((await file(invoice, invoice.payee)).status, "unknown");
  const key = stored().operation.idempotencyKey;
  assert.equal((await file(invoice, invoice.payee)).status, "unknown");
  assert.equal((await recover())[0]?.outcome, "unknown");
  assert.deepEqual(sends, [key]);
  assert.equal(stored().reservation, invoice.amount);
  await assert.rejects(pay({ asset: ASSETS.USDC, amount: "1", recipient: invoice.payee, confidential: true }), UnresolvedOperations);
  assert.throws(() => record({ idempotencyKey: key, refused: "later_policy_denial" }), /cannot resolve/);
  assert.equal(stored().operation.submissionState, "UNKNOWN");
});

test("an initial proven refusal resolves and releases without creating a retry", async () => {
  Object.assign(api, { forGrant: () => ({ transfer: async () => {
    throw new AgentApiError(409, { errors: [{ status: "409", code: "policy_denied", title: "Denied" }] } as never);
  } }) });
  assert.equal((await file(invoice, invoice.payee)).status, "refused");
  assert.equal(stored().reservation, "0");
  assert.equal(stored().operation.submissionState, "RESOLVED");
  assert.equal((await file(invoice, invoice.payee)).status, "refused");
});

test("retryable provider errors remain unknown with the same reserved payment", async () => {
  Object.assign(api, { forGrant: () => ({ transfer: async () => {
    throw new AgentApiError(503, { errors: [{ status: "503", code: "unavailable", title: "Retry later" }], meta: { retryable: true } } as never);
  } }) });
  assert.equal((await file(invoice, invoice.payee)).status, "unknown");
  assert.equal(stored().reservation, invoice.amount);
});

test("an unstructured timeout preserves the invoice reservation and never permits a second send", async () => {
  Object.assign(api, { forGrant: () => ({ transfer: async (_id: string, _request: unknown, { idempotencyKey }: { idempotencyKey: string }) => {
    sends.push(idempotencyKey);
    throw new AgentApiError(408, undefined);
  } }) });
  assert.equal((await file(invoice, invoice.payee)).status, "unknown");
  const key = stored().operation.idempotencyKey;
  assert.equal(stored().reservation, invoice.amount);
  assert.equal(stored().operation.refused, undefined);
  assert.equal((await file(invoice, invoice.payee)).status, "unknown");
  assert.equal((await recover())[0]?.outcome, "unknown");
  await assert.rejects(pay({ asset: ASSETS.USDC, amount: "1", recipient: invoice.payee, confidential: true }), UnresolvedOperations);
  assert.deepEqual(sends, [key]);
});

test("only never-submitted payments can be cancelled and release their reservation", () => {
  const saved = prepareInvoice(invoice, ASSETS.USDC);
  cancelPreparedInvoice(saved.id);
  assert.equal(stored().reservation, "0");
  assert.throws(() => claimInvoiceSubmission(saved.operation.idempotencyKey, saved.operation.request), /replay is blocked/);
});

test("cancellation after submission-attempted cannot erase uncertainty", () => {
  const saved = prepareInvoice(invoice, ASSETS.USDC);
  claimInvoiceSubmission(saved.operation.idempotencyKey, saved.operation.request);
  const before = stored();
  // A refused cancellation (typed for the owner), which says nothing about whether the payment was submitted.
  assert.throws(() => cancelPreparedInvoice(saved.id), (error: unknown) => error instanceof PublicError && /never-submitted/.test(error.message));
  assert.deepEqual(stored(), before, "the invoice keeps its identity and status");
  assert.equal(stored().reservation, invoice.amount);
});

test("a payout policy changed to bypass owner approval stops before submission", async () => {
  // A policy in force (applied, synced) whose owner approval is removed after the first read: only the approval rule refuses it.
  let reads = 0;
  Object.assign(api, { getPolicy: async () => { reads++; return policyView({ ...payoutPolicy([invoice.payee]), owner_approval: reads === 1 }, reads); } });
  assert.deepEqual(await file(invoice, invoice.payee), { id: stored().id, status: "refused", code: "owner_approval_required" });
  assert.ok(reads >= 2, "the changed policy was read before submission");
  // Refused before submission: the invoice stays prepared on its identity, its reservation retained for a retry.
  assert.equal(stored().operation.submissionState, "PREPARED");
  assert.equal(stored().operation.refused, undefined);
  assert.equal(stored().reservation, invoice.amount);
  assert.equal(sends.length, 0);
});

test("polling settles the original operation and releases the reservation atomically", async () => {
  await file(invoice, invoice.payee);
  Object.assign(api, { getStatus: async () => { throw new Error("status unavailable"); } });
  // A failed read is no evidence: the payment shows as last recorded.
  assert.equal((await mine(invoice.payee))[0]?.status, "waiting");
  assert.equal(stored().reservation, invoice.amount);
  Object.assign(api, { getStatus: async (correlation_id: string) => ({ correlation_id, status: "SUCCESS" }) });
  await recover();
  assert.equal(stored().operation.status, "SUCCESS");
  assert.equal(stored().reservation, "0");
  markInvoiceUnknown(stored().operation.idempotencyKey);
  record({ idempotencyKey: stored().operation.idempotencyKey, correlation_id: "op_invoice", status: "PROCESSING" });
  assert.equal(stored().operation.status, "SUCCESS", "stale reads cannot overwrite terminal evidence");
  assert.equal(sends.length, 1);
});

test("identity checks refuse cross-payee filing and listing", async () => {
  await assert.rejects(file(invoice, "mallory.near"), /another account/);
  await file(invoice, invoice.payee);
  assert.deepEqual(await mine("mallory.near"), []);
});

test("the lowest send boundary rejects changed bodies and repeated attempts", () => {
  const saved = prepareInvoice(invoice, ASSETS.USDC);
  assert.throws(() => claimInvoiceSubmission(saved.operation.idempotencyKey, { ...saved.operation.request, amount: "2" }), /body changed/);
  claimInvoiceSubmission(saved.operation.idempotencyKey, saved.operation.request);
  assert.throws(() => claimInvoiceSubmission(saved.operation.idempotencyKey, saved.operation.request), /replay is blocked/);
});

test("losing the database fails closed rather than creating an empty replacement", async () => {
  prepareInvoice(invoice, ASSETS.USDC);
  rmSync(invoiceDatabasePath());
  assert.throws(() => getInvoice(invoiceId(invoice)), /database is missing/);
  await assert.rejects(acquireMoneyLock(), /database is missing/);
});

const providerLines = (dir: string) => existsSync(join(dir, "provider.jsonl")) ? readFileSync(join(dir, "provider.jsonl"), "utf8").trim().split("\n").map((s) => JSON.parse(s)) : [];
function child(mode: string, dir: string) {
  return spawnSync(TSX, [FIXTURE, mode], { cwd: dir, env: { ...process.env, ENV_FILE: "" }, encoding: "utf8", timeout: 20_000 });
}
for (const boundary of ["before_prepare_commit", "after_prepare_commit", "before_attempt_commit", "after_attempt_commit", "after_remote_acceptance", "before_correlation_commit", "after_correlation_commit", "before_settlement_commit", "after_settlement_commit"]) {
  test(`restart at ${boundary} retains identity and never replays an attempted submission`, () => {
    const dir = process.cwd();
    const crash = child(boundary, dir);
    assert.equal(crash.status, 71, crash.stderr);
    const before = getInvoice(invoiceId(invoice));
    // Abrupt process exit intentionally leaves the old filesystem lease. Tests remove only that
    // test directory's stale lease; lock takeover itself is covered by lock.test.ts.
    rmSync(join(dir, ".ops", `${process.env.AGENT_ID}.jsonl.lock`), { recursive: true, force: true });
    const restart = child("recover", dir);
    assert.equal(restart.status, 0, restart.stderr);
    const after = JSON.parse(restart.stdout).invoice as ReturnType<typeof stored>;
    // Only a crash before the preparation commits leaves no invoice; at every later boundary it exists and keeps its identity.
    assert.equal(Boolean(before), boundary !== "before_prepare_commit", "an invoice exists exactly after its preparation committed");
    if (boundary !== "before_prepare_commit") assert.equal(after.operation.idempotencyKey, before!.operation.idempotencyKey);
    const attemptedWithoutSend = boundary === "after_attempt_commit";
    assert.equal(providerLines(dir).length, attemptedWithoutSend ? 0 : 1);
    if (attemptedWithoutSend || boundary === "after_remote_acceptance" || boundary === "before_correlation_commit") {
      assert.equal(after.operation.status, "UNKNOWN");
      assert.equal(after.reservation, invoice.amount);
    } else {
      assert.equal(after.operation.status, "SUCCESS");
      assert.equal(after.reservation, "0");
    }
    assert.equal(listInvoices().length, 1);
    assert.equal(readOps().length, 1);
    assert.equal(child("recover", dir).status, 0);
    assert.equal(providerLines(dir).length, attemptedWithoutSend ? 0 : 1);
  });
}

test("legacy invoices are imported read-only, moved aside, and a stale writer can't break the store", async () => {
  // Initialize directory without opening the new store.
  const { mkdirSync } = await import("node:fs");
  mkdirSync(".invoices");
  const path = join(".invoices", `${process.env.AGENT_ID}.jsonl`);
  const entry = { id: invoiceId(invoice), payee: invoice.payee, amount: invoice.amount, at: new Date().toISOString(), status: "waiting" };
  writeFileSync(path, JSON.stringify(entry) + "\n");
  assert.equal((await file(invoice, invoice.payee)).status, "needs_review");
  assert.deepEqual(sends, [], "a legacy id is never filed again");
  assert.equal(existsSync(path), false, "imported, then moved aside");
  const [shown] = await mine(invoice.payee);
  assert.equal(shown?.id, entry.id);
  assert.equal(shown?.status, "needs_review", "an open legacy invoice needs review");
  // An old writer still running starts a new file: it is imported too, and nothing throws.
  writeFileSync(path, JSON.stringify({ ...entry, status: "paid" }) + "\n");
  assert.doesNotThrow(() => listInvoices());
  assert.equal((await mine(invoice.payee))[0]?.status, "paid", "a recorded outcome is shown as it was");
  assert.equal((await file(invoice, invoice.payee)).status, "needs_review");
  assert.deepEqual(sends, []);
});

test("an invoice payment follows the journal's transitions: no provider outcome before its submission claim", () => {
  const prepared = prepareInvoice(invoice, ASSETS.USDC);
  const key = prepared.operation.idempotencyKey;
  assert.throws(() => record({ idempotencyKey: key, correlation_id: "unclaimed", status: "SUCCESS" }), /submission claim/);
  assert.equal(getInvoice(prepared.id)!.operation.submissionState, "PREPARED");
  assert.ok(claimInvoiceSubmission(key, JSON.parse(JSON.stringify(prepared.operation.request))));
  record({ idempotencyKey: key, correlation_id: "claimed", status: "UNCERTAIN" });
  assert.equal(getInvoice(prepared.id)!.operation.submissionState, "UNKNOWN");
  record({ idempotencyKey: key, correlation_id: "claimed", status: "SUCCESS" });
  assert.equal(getInvoice(prepared.id)!.operation.submissionState, "RESOLVED");
});

test("a held payout the provider names no approval for still counts toward the waiting limit", async () => {
  for (let n = 0; n < 10; n++) {
    record({ at: new Date().toISOString(), idempotencyKey: `held-${n}`, kind: "payout", method: "transfer",
      request: { asset: ASSETS.USDC, amount: "1", recipient: `payee-${n}.near`, confidential: true } });
    record({ idempotencyKey: `held-${n}`, correlation_id: `held-op-${n}`, status: "PENDING_APPROVAL" });
  }
  // Nine carry an approval to vote on; the provider names none for the tenth yet.
  Object.assign(api, { getStatus: async (correlation_id: string) => ({ correlation_id, status: "PENDING_APPROVAL",
    details: correlation_id === "held-op-9" ? {} : { approval_id: `approval-${correlation_id}` } }) });
  assert.deepEqual(await file(invoice, invoice.payee), { id: invoiceId(invoice), status: "busy" });
  assert.deepEqual(sends, []);
});
