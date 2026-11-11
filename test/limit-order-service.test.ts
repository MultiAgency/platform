import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test, type TestContext } from "node:test";
import { generateKey, Near, type PrivateKey } from "near-kit";
import type { Policy } from "@near-intents-agent-api/sdk";
import { freshDirectory, offline } from "./fixtures/harness.js";

process.env.NEAR_INTENTS_AGENT_API_KEY ??= "offline-limit-service-key";
process.env.AGENT_ID = "a".repeat(64);
process.env.AGENT_GRANT_TOKEN = "offline-limit-service-grant";
process.env.EXECUTOR = "on";

const { api } = await import("../src/api.js");
const { limitOrderText, limitOrderView, limitOrderQuoteOutput } = await import("../src/contract/limit-orders.js");
const { approveLimitOrder, createLimitOrder, getLimitOrder, placeLimitOrder, quoteLimitOrder, refreshLimitOrder, rejectLimitOrder } = await import("../src/limit-orders/service.js");
const { readOps } = await import("../src/ops.js");
const { ASSETS, treasuryPolicy } = await import("../src/policy.js");
const { loadStrategy, saveStrategy } = await import("../src/strategy.js");
const { fixtureGrant, policyView, timedPrices } = await import("./fixtures/authority.js");

freshDirectory("limit-order-service");
const HOST = "platform.test";
const app = { actor: "app:treasury:org_1", consent: "c".repeat(64), consents: ["c".repeat(64)], host: HOST };
const owner = generateKey();
let policy: Policy;
let revision: number;
let fills: "open" | "partially_filled" | "completed";
let submissions: number;

beforeEach(() => {
  offline();
  process.env.AGENT_ID = "a".repeat(64);
  process.env.AGENT_GRANT_TOKEN = "offline-limit-service-grant";
  process.env.EXECUTOR = "on";
  policy = { ...treasuryPolicy, actions: ["swap", "limit_order"], limit_order: { max_deviation_bps: 300 } };
  revision = 1; fills = "open"; submissions = 0;
});

function setup(t: TestContext) {
  t.mock.method(api, "getPolicy", async () => policyView(policy, revision) as never);
  t.mock.method(api, "getTokens", async () => timedPrices([
    { asset_id: ASSETS.wNEAR, symbol: "wNEAR", decimals: 24, price: 2.5 },
    { asset_id: ASSETS.USDC, symbol: "USDC", decimals: 6, price: 1 },
  ]) as never);
  t.mock.method(api, "listGrants", async () => [fixtureGrant("treasury")] as never);
  t.mock.method(api, "placeLimitOrder", async (_agent: string, request: { dry?: boolean }) => {
    assert.equal(request.dry, true);
    return { type: "limit_order", dry: true, warnings: [], quote: { spend_asset: ASSETS.USDC, spend_amount: "2500000" },
      owner_approval: false, fee: {} } as never;
  });
  t.mock.method(api, "forGrant", () => ({ placeLimitOrder: async (_agent: string, _request: unknown, options: { idempotencyKey: string }) => {
    submissions++;
    assert.match(options.idempotencyKey, /^limit-order:[a-f0-9]{32}$/);
    return { correlation_id: "order-correlation" };
  } }) as never);
  t.mock.method(api, "getStatus", async () => ({ correlation_id: "order-correlation", agent_id: process.env.AGENT_ID,
    type: "limit_order", status: "SUCCESS", details: { order_id: "resting-order" } }) as never);
  t.mock.method(api, "getLimitOrder", async () => ({ order_id: "resting-order",
    fill_status: fills === "completed" ? "filled" : fills, payout_status: fills === "completed" ? "completed" : "in_progress",
    is_payout_status_final: fills === "completed", partial_fills: fills === "open" ? [] : [{ amount: "retained" }],
    payouts: fills === "completed" ? { withdrawal: { state: "completed" } } : {} }) as never);
}

const terms = (requestId: string) => ({ requestId, base_asset: ASSETS.wNEAR, quote_asset: ASSETS.USDC,
  side: "buy" as const, quantity: "1000000000000000000000000", price: "2.5", confidential: true as const,
  deadline: new Date(Date.now() + 2 * 3_600_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
async function sign(message: string) {
  const near = new Near({ network: "mainnet", privateKey: owner.secretKey as PrivateKey, defaultSignerId: "owner.near" });
  const nonce = randomBytes(32);
  const signed = await near.signMessage({ message, recipient: HOST, nonce });
  return { message, nonce: nonce.toString("base64"), publicKey: signed.publicKey, signature: signed.signature };
}

test("app proposal, exact owner signature, one placement, partial fill and final payout are separate states", async t => {
  setup(t);
  const input = terms("one-order");
  const preview = await quoteLimitOrder(app, (({ requestId: _id, expiresAt: _expiry, ...order }) => order)(input));
  assert.equal(limitOrderQuoteOutput.safeParse(preview).success, true);
  const proposed = await createLimitOrder(app, input);
  assert.equal(proposed.state, "proposed");
  assert.equal(submissions, 0);
  const signed = await sign(limitOrderText(proposed, "approve"));
  const approved = await approveLimitOrder(app, { id: proposed.id, signed });
  assert.equal(approved.state, "approved");
  assert.equal(approved.approvalSignatureHash, createHash("sha256").update(signed.signature).digest("hex"),
    "a DAO vote relay can prove this exact owner signature survived a lost reply by reading state");
  assert.equal((await approveLimitOrder(app, { id: proposed.id, signed })).state, "approved", "lost approval answer is read by identity");
  const placed = await placeLimitOrder(app, { id: proposed.id });
  assert.equal(placed.state, "resting", "provider SUCCESS funded the order; it did not fill it");
  assert.equal(placed.orderId, "resting-order");
  assert.equal(submissions, 1);
  assert.equal((await placeLimitOrder(app, { id: proposed.id })).state, "resting");
  assert.equal(submissions, 1, "a repeated app request only reads the claimed proposal");
  fills = "partially_filled";
  assert.equal((await refreshLimitOrder(app, { id: proposed.id })).state, "partially_filled");
  fills = "completed";
  const done = await refreshLimitOrder(app, { id: proposed.id });
  assert.equal(done.state, "completed");
  assert.equal(done.isPayoutStatusFinal, true);
  assert.equal(limitOrderView.safeParse(done).success, true);
  assert.equal(readOps().find(op => op.method === "limit_order")?.status, "SUCCESS");
});

test("a funded order with lost placement identity reads unknown, never placing", async t => {
  setup(t);
  const proposed = await createLimitOrder(app, terms("lost-placement-read"));
  await approveLimitOrder(app, { id: proposed.id, signed: await sign(limitOrderText(proposed, "approve")) });
  assert.equal((await placeLimitOrder(app, { id: proposed.id })).state, "resting");
  unlinkSync(join(".proposals", "limit-orders", process.env.AGENT_ID!, `${proposed.id}.placed.json`));
  const read = getLimitOrder(app, { id: proposed.id });
  assert.equal(read.state, "unknown");
  assert.match(read.reason ?? "", /provider identity is missing/);
});

test("an exact signed rejection has a read-only receipt and never places an order", async t => {
  setup(t);
  const proposed = await createLimitOrder(app, terms("rejected-order"));
  const signed = await sign(limitOrderText(proposed, "reject"));
  const rejected = rejectLimitOrder(app, { id: proposed.id, signed });
  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.rejectionSignatureHash, createHash("sha256").update(signed.signature).digest("hex"));
  assert.equal(getLimitOrder(app, { id: proposed.id }).rejectionSignatureHash, rejected.rejectionSignatureHash);
  assert.equal(submissions, 0);
});

test("a changed policy invalidates the signed proposal before placement", async t => {
  setup(t);
  const proposed = await createLimitOrder(app, terms("changed-policy"));
  revision = 2;
  await assert.rejects(approveLimitOrder(app, { id: proposed.id, signed: await sign(limitOrderText(proposed, "approve")) }),
    (error: unknown) => (error as { data?: { code?: string } }).data?.code === "invalidated");
  assert.equal(getLimitOrder(app, { id: proposed.id }).state, "invalidated");
  assert.equal(submissions, 0);
});

test("an unlisted output asset and a cash floor refuse creation before owner approval", async t => {
  setup(t);
  policy = { ...policy, assets: [ASSETS.USDC] };
  await assert.rejects(createLimitOrder(app, terms("unlisted-output")),
    (error: unknown) => (error as { data?: { code?: string } }).data?.code === "asset_out_not_allowed");
  policy = { ...policy, assets: [ASSETS.USDC, ASSETS.wNEAR] };
  const prior = loadStrategy();
  saveStrategy({ ...prior, cashFloor: { usd: 1, assets: [ASSETS.USDC] } });
  await assert.rejects(createLimitOrder(app, terms("cash-floor")),
    (error: unknown) => (error as { data?: { code?: string } }).data?.code === "cash_floor_order_unsupported");
  saveStrategy(prior);
  assert.equal(submissions, 0);
});
