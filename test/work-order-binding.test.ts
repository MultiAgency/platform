import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import { api } from "../src/api.js";
import { ownerRequests } from "../src/owner-requests.js";
import { grantRequest } from "../src/grants.js";
import { file } from "../src/invoices.js";
import { pay } from "../src/agent.js";
import { ASSETS } from "../src/policy.js";
import { getInvoice, invoiceId } from "../src/invoice-store.js";
import { createWorkOrder, workOrderInvoice, workOrderPolicy, type WorkOrder } from "../src/work-order-store.js";
import { freshDirectory } from "./fixtures/harness.js";
import { authorityFixture, fixtureGrant, fixtureOwner, policyView } from "./fixtures/authority.js";

freshDirectory("work-order-binding");
let order: WorkOrder;
let sends: string[];
beforeEach(() => {
  order = createWorkOrder("parent-agent", { id: "12345678-1234-4234-8234-123456789abc",
    payee: "alice.near", amount: "1000000", note: "Design work", until: new Date(Date.now() + 3_600_000).toISOString(),
    asset: ASSETS.USDC, owner: fixtureOwner });
  process.env.WORK_ORDER_PARENT = order.parentAgentId;
  process.env.WORK_ORDER_ID = order.id;
  process.env.AGENT_GRANT_TOKEN = "ngt_test";
  sends = [];
  Object.assign(api, { ...authorityFixture(), getPolicy: async () => policyView(workOrderPolicy(order)),
    listGrants: async () => [{ ...fixtureGrant("invoices"), expires_at: order.until }],
    forGrant: () => ({ transfer: async (_id: string, _request: unknown, { idempotencyKey }: { idempotencyKey: string }) => {
      sends.push(idempotencyKey); return { correlation_id: "order-payment" };
    } }), getStatus: async (correlation_id: string) => ({ correlation_id, status: "PENDING_APPROVAL", details: { approval_id: "approval" } }) });
});

test("owner creation signs the fixed work-order policy and grant expires at its deadline", async () => {
  assert.deepEqual(ownerRequests.agent_create(fixtureOwner, "payout", [order.payee]).policy, workOrderPolicy(order));
  assert.throws(() => ownerRequests.agent_create({ ...fixtureOwner, account_id: "other.near" }, "payout"), /owner/);
  assert.equal((await grantRequest({ label: "invoices" })).request.expires_at, order.until);
  await assert.rejects(grantRequest({ label: "treasury" }), /work order/i);
  // The order's deadline is the grant's expiry: the same one is accepted, any other refused.
  assert.equal((await grantRequest({ label: "invoices", expiresAt: order.until })).request.expires_at, order.until);
  await assert.rejects(grantRequest({ label: "invoices", expiresAt: new Date(Date.parse(order.until) - 60_000).toISOString() }), /work order/i);
});

test("altered terms and fresh submission identities cannot become payments in an order executor", async () => {
  const invoice = workOrderInvoice(order, order.payee);
  for (const changed of [{ amount: "1" }, { note: "Different work" }, { submission: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }, { payee: "bob.near" }])
    await assert.rejects(file({ ...invoice, ...changed }, changed.payee ?? order.payee), /work order/i);
  assert.equal(sends.length, 0);
});

test("concurrent filing uses one order payment and later status requests never send again", async () => {
  const invoice = workOrderInvoice(order, order.payee);
  const results = await Promise.all(Array.from({ length: 8 }, () => file(invoice, order.payee)));
  assert.ok(results.every(result => result.status === "waiting"));
  assert.equal(sends.length, 1);
  assert.equal(getInvoice(invoiceId(invoice))!.operation.policyDigest?.startsWith("sha256:"), true);
  await file(invoice, order.payee);
  assert.equal(sends.length, 1);
});

/** A local refusal leaves the order invoice prepared on its identity (retryable), with no refusal recorded on it. */
const stillPrepared = (input: ReturnType<typeof workOrderInvoice>) => getInvoice(invoiceId(input))?.operation.submissionState === "PREPARED" && getInvoice(invoiceId(input))?.operation.refused === undefined;

test("manual payments cannot bypass the order's single invoice identity", async () => {
  assert.deepEqual(await pay({ asset: order.asset, amount: order.amount, recipient: order.payee, confidential: true }),
    { outcome: "refused", code: "work_order_binding" });
  assert.equal(sends.length, 0);
});

test("a mismatched grant deadline is refused at dispatch even when the policy permits the payment", async () => {
  Object.assign(api, { listGrants: async () => [fixtureGrant("invoices")] });
  assert.deepEqual(await file(workOrderInvoice(order, order.payee), order.payee), { id: invoiceId(workOrderInvoice(order, order.payee)), status: "refused", code: "work_order_binding" });
  assert.ok(stillPrepared(workOrderInvoice(order, order.payee)));
  assert.equal(sends.length, 0);
});

test("deadline crossing during dispatch observations refuses without a provider submission", async () => {
  const input = workOrderInvoice(order, order.payee);
  const tokens = api.getTokens.bind(api);
  Object.assign(api, { getTokens: async () => {
    const result = await tokens();
    mock.method(Date, "now", () => Date.parse(order.until));
    return result;
  } });
  try {
    assert.deepEqual(await file(input, order.payee), { id: invoiceId(input), status: "refused", code: "work_order_binding" });
    assert.ok(stillPrepared(input));
    assert.equal(sends.length, 0);
  } finally { mock.restoreAll(); }
});

test("a policy changed between intake and dispatch cannot release an altered order payment", async () => {
  let reads = 0;
  Object.assign(api, { getPolicy: async () => policyView({ ...workOrderPolicy(order), owner_approval: ++reads === 1 }) });
  assert.deepEqual(await file(workOrderInvoice(order, order.payee), order.payee), { id: invoiceId(workOrderInvoice(order, order.payee)), status: "refused", code: "work_order_binding" });
  assert.ok(stillPrepared(workOrderInvoice(order, order.payee)));
  assert.equal(sends.length, 0);
});

test("an interrupted order payment stays on its original unresolved identity", async () => {
  Object.assign(api, { forGrant: () => ({ transfer: async (_id: string, _request: unknown, { idempotencyKey }: { idempotencyKey: string }) => {
    sends.push(idempotencyKey); throw new Error("response lost");
  } }) });
  const input = workOrderInvoice(order, order.payee);
  assert.equal((await file(input, order.payee)).status, "unknown");
  assert.equal((await file(input, order.payee)).status, "unknown");
  assert.equal(sends.length, 1);
  assert.equal(getInvoice(invoiceId(input))!.operation.idempotencyKey, sends[0]);
});

test("owner submission requires exact observed funding and follows the original invoice after replenishment", async () => {
  const { handleWorkOrderCommand } = await import("../src/work-order-runtime.js");
  Object.assign(api, { getBalances: async (_id: string, { source }: { source: string }) => ({ source, balances: [{ asset_id: order.asset, balance_raw: "2000000" }] }) });
  await assert.rejects(handleWorkOrderCommand({ type: "file", payee: order.payee }), /exactly the approved funding/);
  assert.equal(sends.length, 0);
  Object.assign(api, { getBalances: async (_id: string, { source }: { source: string }) => ({ source, balances: [{ asset_id: order.asset, balance_raw: order.amount }] }) });
  assert.equal((await handleWorkOrderCommand({ type: "file", payee: order.payee }) as { status: string }).status, "waiting");
  Object.assign(api, { getBalances: async (_id: string, { source }: { source: string }) => ({ source, balances: [{ asset_id: order.asset, balance_raw: "9000000" }] }) });
  await handleWorkOrderCommand({ type: "file", payee: order.payee });
  assert.equal(sends.length, 1);
});

test("a creation the owner never signed doesn't block preparing another; any other retained creation does", async t => {
  const { handleWorkOrderCommand } = await import("../src/work-order-runtime.js");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const previous = process.env.AGENT_ID;
  delete process.env.AGENT_ID;
  t.after(() => { process.env.AGENT_ID = previous; });
  let prepared = 0;
  t.mock.method(api, "generateIntent", async () => ({ type: "agent_create", correlation_id: `creation-${++prepared}`, preview: {},
    expires_at: new Date(Date.now() + 60_000).toISOString(), intent: {}, signer: fixtureOwner }) as never);
  const retained = (result: { status: string; failureCode?: string | null }) => {
    mkdirSync(".owner-intents", { recursive: true });
    writeFileSync(".owner-intents/.env.json", JSON.stringify({ earlier: { type: "agent_create", stage: "settled", result,
      expiresAt: new Date(Date.now() - 60_000).toISOString(), signedData: {} } }));
  };
  const create = () => handleWorkOrderCommand({ type: "prepare", action: "create", signer: "wallet" });
  retained({ status: "SUCCESS" });
  await assert.rejects(create(), /retained record/);
  retained({ status: "FAILED", failureCode: "rejected" });
  await assert.rejects(create(), /retained record/, "what a provider FAILED leaves on chain isn't established");
  retained({ status: "EXPIRED", failureCode: "signing_window_closed" });
  await create();
  // Prepared, never signed, its window closed: no agent can come of it, even before the lock drops the record.
  writeFileSync(".owner-intents/.env.json", JSON.stringify({ unsigned: { type: "agent_create", stage: "prepared",
    expiresAt: new Date(Date.now() - 60_000).toISOString() } }));
  await create();
  assert.equal(prepared, 2);
});
