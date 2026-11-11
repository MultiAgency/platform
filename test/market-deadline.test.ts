import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import { generateKey, Near, parseKey, TransactionBuilder } from "near-kit";
import { market } from "./e2e/market.mjs";
import type { z } from "zod";
import type { marketApproveInput } from "../src/contract/market.js";

const sim = await market({ agents: {
  writer: { amount: "500000", windowSeconds: 600, outcome: "complete", result: "article" },
  waiting: { amount: "500000", windowSeconds: 600, outcome: "hold" },
} });
Object.assign(process.env, { MARKET_URL: sim.url, NEAR_RPC_URL: sim.rpc, AGENT_GRANT_TOKEN: "ngt_fixture", HOSTED_OWNER_KIND: "dao" });
const { api } = await import("../src/api.js");
const { approveHire, hireStatus, quoteHire } = await import("../src/market/hire.js");
const { hireText } = await import("../src/contract/market.js");
const { readOps } = await import("../src/ops.js");
const { ASSETS, marketPolicy } = await import("../src/policy.js");
const { authorityFixture, fixtureGrant, policyView, timedPrices } = await import("./fixtures/authority.js");
const { freshDirectory } = await import("./fixtures/harness.js");
const APP = "app:covenant:acme", BRIEF = "Article\nWrite about NEAR.", HOST = "api.test";
const context = { actor: APP, host: HOST };
const daoKey = generateKey().secretKey;
const owner = { type: "near" as const, account_id: "dao-owner.near", public_key: parseKey(daoKey).publicKey.toString() };
let key: string, withdrawals: { asset: string; amount: string; recipient: string }[], paidBefore: number;
freshDirectory("market-deadline");
after(() => sim.close());
beforeEach(context => {
  const t = context as TestContext;
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const secret = generateKey().secretKey;
  process.env.MARKET_PAYMENT_KEY = secret;
  key = Buffer.from(parseKey(secret).publicKey.data).toString("hex");
  sim.register(key);
  withdrawals = [];
  paidBefore = sim.calls.filter(c => c.payment !== null).length;
  for (const [name, method] of Object.entries(authorityFixture())) t.mock.method(api, name as keyof typeof api, method as never);
  t.mock.method(api, "getAgent", async () => ({ id: process.env.AGENT_ID!, owner }));
  t.mock.method(api, "listGrants", async () => [fixtureGrant("market")]);
  t.mock.method(api, "getPolicy", async () => policyView(marketPolicy(key)));
  t.mock.method(api, "getTokens", async () => timedPrices([{ asset_id: ASSETS.USDC, symbol: "USDC", decimals: 6, price: 1 },
    { asset_id: ASSETS.wNEAR, symbol: "wNEAR", decimals: 24, price: 2 }]));
  t.mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, status: "SUCCESS" }));
  t.mock.method(api, "forGrant", () => ({ withdraw: async (_id: string, request: { asset: string; amount: string; recipient: string }) => {
    withdrawals.push(request);
    sim.fund(request.recipient, request.asset === ASSETS.USDC ? request.amount : "0");
    return { correlation_id: `top-up-${withdrawals.length}` };
  } }));
});

async function approval(requestId: string, handle = "writer", brief = BRIEF, validForMs = 1_000): Promise<z.infer<typeof marketApproveInput>> {
  const approved = await quoteHire({ handle, brief });
  const validUntil = new Date(Date.now() + validForMs).toISOString();
  const text = hireText({ requestId, agentId: process.env.AGENT_ID!, deployment: "covenant", organization: "acme", approved, validUntil });
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const signer = new Near({ network: "mainnet", privateKey: daoKey as `ed25519:${string}`, defaultSignerId: owner.account_id });
  const signed = await signer.signMessage({ message: text, recipient: HOST, nonce });
  return { requestId, brief, approved, validUntil, signed: { message: text, nonce: Buffer.from(nonce).toString("base64"),
    publicKey: signed.publicKey.toString(), signature: signed.signature } };
}
const paidCalls = () => sim.calls.filter(c => c.payment !== null).length - paidBefore;
const expired = (result: unknown) => {
  const value = result as { state?: string; code?: string; data?: { code?: string } };
  assert.ok(value.code === "approval_expired" || value.data?.code === "approval_expired", "the unsubmitted payment is explicitly refused for expiry");
};
const attempt = (input: z.infer<typeof marketApproveInput>) => approveHire(context, input).catch((error: unknown) => error);

test("DAO approval expiring during provider ownership lookup prevents every new money send", async t => {
  sim.fund(key, "500000");
  const input = await approval("ownership");
  t.mock.method(api, "getAgent", async () => { t.mock.timers.tick(2_000); return { id: process.env.AGENT_ID!, owner }; });
  expired(await attempt(input));
  assert.equal(withdrawals.length, 0);
  assert.equal(paidCalls(), 0);
});

test("DAO approval expiring during final dispatch policy reads prevents the payment claim", async t => {
  sim.fund(key, "500000");
  const input = await approval("dispatch-reads");
  let policyReads = 0;
  t.mock.method(api, "getPolicy", async () => { if (++policyReads === 2) t.mock.timers.tick(2_000); return policyView(marketPolicy(key)); });
  expired(await attempt(input));
  assert.equal(policyReads, 2, "the early cap preflight passed before the final dispatch read expired");
  assert.equal(withdrawals.length, 0);
  assert.equal(paidCalls(), 0);
  assert.equal(readOps().find(op => op.method === "x402")?.submissionState, "PREPARED");
});

test("expiry while an already submitted USDC top-up settles prevents the payment without denying the top-up", async t => {
  sim.fund(key, "0");
  const input = await approval("top-up-settlement");
  t.mock.method(api, "getStatus", async (correlation_id: string) => { t.mock.timers.tick(2_000); return { correlation_id, status: "SUCCESS" }; });
  const result = await attempt(input);
  expired(result);
  assert.equal(withdrawals.length, 1);
  assert.equal(withdrawals[0]!.amount, "500000");
  assert.equal(paidCalls(), 0);
  assert.equal(readOps().find(op => op.kind === "market-topup" && op.correlationId)?.status, "SUCCESS");
  assert.doesNotMatch(result instanceof Error ? result.message : JSON.stringify(result), /nothing was sent|nothing took effect/i);
});

test("expiry during finality after the opening top-up prevents a second top-up and the payment", async t => {
  const input = await approval("opening-finality");
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(url) === sim.rpc && withdrawals.length === 1) t.mock.timers.tick(2_000);
    return fetch(url, init);
  });
  const result = await attempt(input);
  expired(result);
  assert.deepEqual(withdrawals.map(w => w.asset), [ASSETS.wNEAR]);
  assert.equal(paidCalls(), 0);
  assert.equal(readOps().find(op => op.correlationId)?.status, "SUCCESS");
  assert.doesNotMatch(result instanceof Error ? result.message : JSON.stringify(result), /nothing was sent|nothing took effect/i);
});

test("DAO approval expiring during final delegate signing prevents the claim and paid POST", async t => {
  sim.fund(key, "500000");
  const input = await approval("signing");
  const delegate = TransactionBuilder.prototype.delegate;
  let signed = 0;
  t.mock.method(TransactionBuilder.prototype, "delegate", async function(this: TransactionBuilder, ...args: Parameters<typeof delegate>) {
    const value = await delegate.apply(this, args);
    signed++;
    t.mock.timers.tick(2_000);
    return value;
  });
  expired(await attempt(input));
  assert.equal(signed, 1);
  assert.equal(paidCalls(), 0);
  assert.equal(readOps().find(op => op.method === "x402")?.submissionState, "PREPARED");
});

test("a market grant expiring during delegate signing prevents the payment", async t => {
  sim.fund(key, "500000");
  const input = await approval("grant-signing", "writer", BRIEF, 10_000);
  const grant = fixtureGrant("market"), expiresAt = Date.now() + 1_000;
  grant.expires_at = new Date(expiresAt).toISOString();
  grant.owner_message.expires_at_ms = expiresAt;
  t.mock.method(api, "listGrants", async () => [grant]);
  const delegate = TransactionBuilder.prototype.delegate;
  t.mock.method(TransactionBuilder.prototype, "delegate", async function(this: TransactionBuilder, ...args: Parameters<typeof delegate>) {
    const value = await delegate.apply(this, args);
    t.mock.timers.tick(2_000);
    return value;
  });
  const result = await attempt(input) as { state: string; code: string };
  assert.equal(result.state, "refused");
  assert.equal(result.code, "grant_missing");
  assert.equal(paidCalls(), 0);
  const op = readOps().find(op => op.method === "x402");
  assert.equal(op?.submissionState, "PREPARED");
  assert.equal(op?.refused, "grant_missing");
});

test("a local signer failure before the claim is recorded as never submitted", async t => {
  sim.fund(key, "500000");
  const input = await approval("signer-failure");
  t.mock.method(TransactionBuilder.prototype, "delegate", async () => { throw new Error("local signer failed"); });
  const result = await attempt(input) as { state: string; code: string };
  assert.equal(result.state, "refused");
  assert.equal(result.code, "never_submitted");
  assert.equal(paidCalls(), 0);
  const op = readOps().find(op => op.method === "x402");
  assert.equal(op?.submissionState, "PREPARED");
  assert.equal(op?.refused, "never_submitted");
});

test("expiry during the durable claim refuses a never-posted payment without blocking later sends", async t => {
  sim.fund(key, "500000");
  const input = await approval("claim-boundary");
  const deadline = Date.parse(input.validUntil);
  let crossed = false;
  t.mock.method(Date, "now", () => {
    if (readOps().some(op => op.method === "x402" && op.submissionState === "SUBMISSION_ATTEMPTED")) {
      crossed = true;
      return deadline + 1;
    }
    return deadline - 1;
  });
  const result = await attempt(input) as { state: string; code: string };
  assert.equal(crossed, true, "the clock crossed only after the submission claim was durable");
  assert.equal(result.state, "refused");
  assert.equal(result.code, "approval_expired");
  assert.equal(paidCalls(), 0);
  const op = readOps().find(op => op.method === "x402");
  assert.equal(op?.submissionState, "SUBMISSION_ATTEMPTED");
  assert.equal(op?.refused, "approval_expired");
  assert.equal((await hireStatus(APP, input.requestId)).state, "refused");
  const { acquireMoneyLock } = await import("../src/lock.js");
  await (await acquireMoneyLock()).release();
});

test("an expired approval's already attempted unknown payment remains poll-only", async t => {
  sim.fund(key, "500000");
  const input = await approval("unknown", "waiting");
  assert.equal((await approveHire(context, input)).state, "unknown");
  assert.equal(paidCalls(), 1);
  t.mock.timers.tick(2_000);
  assert.equal((await approveHire(context, input)).state, "unknown");
  assert.equal((await hireStatus(APP, input.requestId)).state, "unknown");
  assert.equal(paidCalls(), 1);
  assert.equal(readOps().filter(op => op.method === "x402").length, 1);
  assert.equal(readOps().find(op => op.method === "x402")?.refused, undefined);
});

test("expiry stops retrying a 502 paid call while preserving its attempted unknown outcome", async t => {
  sim.fund(key, "500000");
  const input = await approval("retry");
  const fetch = globalThis.fetch;
  let posts = 0, expiredDuringWait = false;
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (new Headers(init?.headers).has("x-payment")) {
      posts++;
      if (posts === 1) {
        // The response arrives while approval is live; the next event-loop turn expires it during the retry wait.
        setTimeout(() => { expiredDuringWait = true; t.mock.timers.tick(2_000); }, 0);
        return Response.json({ error: "facilitator unreachable" }, { status: 502 });
      }
    }
    return fetch(url, init);
  });
  assert.equal((await approveHire(context, input)).state, "unknown");
  assert.equal(expiredDuringWait, true);
  assert.equal(posts, 1);
  const op = readOps().find(op => op.method === "x402")!;
  assert.equal(op.submissionState, "SUBMISSION_ATTEMPTED");
  assert.equal(op.refused, undefined);
  assert.equal((await approveHire(context, input)).state, "unknown");
  assert.equal(posts, 1);
});

test("reusing a paid requestId for another brief refuses a conflict and never pays the new terms", async () => {
  sim.fund(key, "500000");
  const input = await approval("conflict");
  await approveHire(context, input);
  assert.equal((await hireStatus(APP, input.requestId)).state, "paid");
  const changed = await approval(input.requestId, "writer", BRIEF + " Different work.");
  await assert.rejects(approveHire(context, changed), (error: unknown) => (error as { data?: { code?: string } }).data?.code === "request_conflict");
  assert.equal(paidCalls(), 1);
});
