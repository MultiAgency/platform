import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import { generateKey, parseKey } from "near-kit";
import { MARKET_USDC, market } from "./e2e/market.mjs";

/**
 * A market hire through the real money path (docs/market.md): the money lock, the journal, `authorize`, the one send
 * site. The Agent API is a stand-in (its withdrawals land on the simulated chain); the market and the chain the
 * payment key lives on are simulated, on loopback.
 */

const sim = await market({ agents: {
  writer: { amount: "500000", windowSeconds: 600, outcome: "complete", result: "the article" },
  refuser: { amount: "500000", windowSeconds: 600, outcome: "reject" },
} });
const secretKey = generateKey().secretKey;
const KEY = Buffer.from(parseKey(secretKey).publicKey.data).toString("hex");
Object.assign(process.env, { MARKET_URL: sim.url, NEAR_RPC_URL: sim.rpc, MARKET_PAYMENT_KEY: secretKey, AGENT_GRANT_TOKEN: "ngt_fixture" });
// Read after the environment points at the simulators: chain.ts fixes its RPC endpoint on import.
const { api } = await import("../src/api.js");
const { readOps } = await import("../src/ops.js");
const { ASSETS, marketPolicy } = await import("../src/policy.js");
const { hire, hireStatus, quoteHire } = await import("../src/market/hire.js");
const { acquireMoneyLock, UnresolvedOperations } = await import("../src/lock.js");
const { requestKey } = await import("../src/payout-requests.js");
const { authorityFixture, fixtureGrant, policyView, timedPrices } = await import("./fixtures/authority.js");
const { freshDirectory } = await import("./fixtures/harness.js");

const APP = "app:covenant:acme";
let withdrawals: { asset: string; amount: string; recipient: string; key: string }[];

freshDirectory("market-hire");
after(() => sim.close());
beforeEach(() => {
  withdrawals = [];
  for (const [name, method] of Object.entries(authorityFixture())) mock.method(api, name as keyof typeof api, method as never);
  mock.method(api, "listGrants", async () => [fixtureGrant("market")]);
  mock.method(api, "getPolicy", async () => policyView(marketPolicy(KEY)));
  mock.method(api, "getTokens", async () => timedPrices([{ asset_id: ASSETS.USDC, symbol: "USDC", decimals: 6, price: 1 },
    { asset_id: ASSETS.wNEAR, symbol: "wNEAR", decimals: 24, price: 2 }]));
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, status: "SUCCESS" }));
  // The provider's withdrawal lands on the simulated chain: wNEAR opens the key's account, USDC credits it.
  const withdraw = async (_id: string, request: { asset: string; amount: string; recipient: string }, { idempotencyKey }: { idempotencyKey: string }) => {
    withdrawals.push({ ...request, key: idempotencyKey });
    sim.fund(request.recipient, request.asset === ASSETS.USDC ? request.amount : "0");
    return { correlation_id: `op_${withdrawals.length}` };
  };
  mock.method(api, "forGrant", () => ({ withdraw }));
});

const BRIEF = "An article\nWrite 300 words on NEAR Intents.";

test("a hire is refused, with nothing sent, until the owner registers the payment key on USDC", async () => {
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  await assert.rejects(hire(APP, { requestId: "h-0", brief: BRIEF, approved }), /payment_key_unregistered|registers the payment key/);
  assert.deepEqual(withdrawals, []);
  assert.equal(readOps().length, 0);
});

test("a hire opens and funds the payment key, pays once, and reads paid from the chain with its deliverable", async () => {
  sim.register(KEY);
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  assert.equal(approved.amount, "500000");
  const answer = await hire(APP, { requestId: "h-1", brief: BRIEF, approved });
  // The account didn't exist: one wNEAR withdrawal opened it, one USDC withdrawal of exactly the price funded it.
  assert.deepEqual(withdrawals.map(w => [w.asset, w.amount, w.recipient]), [[ASSETS.wNEAR, "20000000000000000000000", KEY], [ASSETS.USDC, "500000", KEY]]);
  assert.equal(answer.state, "unknown", `taken by the market; the chain hasn't been read yet (${answer.code})`);
  assert.ok(answer.taskId);
  const status = await hireStatus(APP, "h-1");
  assert.equal(status.state, "paid");
  assert.equal(status.deliverable, "the article");
  const op = readOps().find(o => o.idempotencyKey === requestKey(APP, "h-1"))!;
  assert.equal(op.method, "x402");
  assert.equal(op.status, "SUCCESS");
  assert.equal(op.correlationId, `x402:${KEY}:1`);
  assert.equal(sim.chain.accounts.get(KEY).transfers.length, 1);
  // Asked again: the journal's answer, and nothing sent.
  assert.equal((await hire(APP, { requestId: "h-1", brief: BRIEF, approved })).state, "paid");
  assert.equal(withdrawals.length, 2);
  assert.equal(sim.chain.accounts.get(KEY).transfers.length, 1);
});

test("a hire pays only the terms approved: a changed quote or another brief is refused, with nothing sent", async () => {
  sim.register(KEY);
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  await assert.rejects(hire(APP, { requestId: "h-2", brief: BRIEF, approved: { ...approved, amount: "400000" } }), /quote_changed|terms changed/);
  await assert.rejects(hire(APP, { requestId: "h-3", brief: `${BRIEF}!`, approved }), /isn't the one approved/);
  assert.deepEqual(withdrawals, []);
  assert.equal(readOps().length, 0);
});

test("an undelivered hire blocks the agent's sends while its payment can settle, then reads not charged", async () => {
  sim.register(KEY);
  sim.fund(KEY, "500000");
  const approved = await quoteHire({ handle: "refuser", brief: BRIEF });
  const answer = await hire(APP, { requestId: "h-4", brief: BRIEF, approved });
  assert.equal(answer.taskState, "TASK_STATE_REJECTED");
  assert.deepEqual(withdrawals, [], "the key already held the price");
  assert.equal((await hireStatus(APP, "h-4")).state, "unknown");
  await assert.rejects(acquireMoneyLock(), (error: unknown) => error instanceof UnresolvedOperations);
  const op = readOps().find(o => o.idempotencyKey === requestKey(APP, "h-4"))!;
  sim.advance(BigInt(String(op.request.maxBlockHeight)) - sim.chain.height + 1n);
  assert.equal((await hireStatus(APP, "h-4")).state, "not_charged");
  const lock = await acquireMoneyLock();
  await lock.release();
});

test("an app reaches hires only with market consent, and market consent reaches nothing else that spends", async () => {
  const { appScopesCover } = await import("../src/contract/app-access.js");
  for (const path of ["market/quote", "market/hire", "market/status", "market/account", "deposit"])
    assert.equal(appScopesCover(["market"], path), true, path);
  for (const path of ["market/hire", "market/quote"]) assert.equal(appScopesCover(["read", "owner", "payout", "treasury", "treasury-execute"], path), false, path);
  for (const path of ["payouts/request", "pay", "sweep", "executePlan", "owner/prepare", "overview"]) assert.equal(appScopesCover(["market"], path), false, path);
  const { mayCall } = await import("../src/contract/permissions.js");
  const reader = { canSign: false, canPropose: false, canVote: false, canExecute: false, canManage: false };
  assert.equal(mayCall(reader, "market/status"), true);
  assert.equal(mayCall(reader, "market/hire"), false, "a hire spends: it needs execute access");
  assert.equal(mayCall({ ...reader, canExecute: true }, "market/hire"), true);
});

test("the procedures answer as the app sees them: quote, hire, status, and the payment key's account", async () => {
  const { createRouterClient } = await import("@orpc/server");
  const { router } = await import("../src/router.js");
  const client = createRouterClient(router, { context: { actor: APP } });
  sim.register(KEY);
  const account = await client.market.account();
  assert.equal(account.account, KEY);
  assert.equal(account.registered, true);
  assert.equal(account.registration, null);
  const approved = await client.market.quote({ handle: "writer", brief: BRIEF });
  const hired = await client.market.hire({ requestId: "p-1", brief: BRIEF, approved });
  assert.equal(hired.requestId, "p-1");
  const status = await client.market.status({ requestId: "p-1" });
  assert.equal(status.state, "paid");
  // Another caller's same requestId is another hire: it doesn't see this one.
  const other = createRouterClient(router, { context: { actor: "app:other:org" } });
  assert.equal((await other.market.status({ requestId: "p-1" })).state, "not_found");
});

test("an unregistered payment key's account carries the owner's registration transaction", async () => {
  const fresh = generateKey().secretKey;
  const before = process.env.MARKET_PAYMENT_KEY;
  process.env.MARKET_PAYMENT_KEY = fresh;
  try {
    const { marketAccount } = await import("../src/market/hire.js");
    const account = await marketAccount();
    assert.equal(account.registered, false);
    assert.equal(account.opened, false);
    assert.deepEqual(account.registration, { receiverId: MARKET_USDC, actions: [{ type: "FunctionCall", params: { methodName: "storage_deposit",
      args: { account_id: account.account, registration_only: true }, gas: "30000000000000", deposit: "1250000000000000000000" } }] });
  } finally { process.env.MARKET_PAYMENT_KEY = before; }
});

/** A DAO-owned market agent (docs/market.md): each hire is paid only after the DAO signs its exact terms. */
async function daoApproval(change: { key?: string; validUntil?: string; text?: string; host?: string } = {}) {
  const { Near } = await import("near-kit");
  const { hireText } = await import("../src/contract/market.js");
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  const validUntil = change.validUntil ?? new Date(Date.now() + 3_600_000).toISOString();
  const text = change.text ?? hireText({ requestId: "d-1", agentId: process.env.AGENT_ID!, deployment: "covenant", organization: "acme", approved, validUntil });
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const signer = change.key ?? DAO_KEY;
  const near = new Near({ network: "mainnet", privateKey: signer as `ed25519:${string}`, defaultSignerId: "dao-signer.near" });
  const signed = await near.signMessage({ message: text, recipient: change.host ?? "api.test", nonce });
  return { requestId: "d-1", brief: BRIEF, approved, validUntil,
    signed: { message: text, nonce: Buffer.from(nonce).toString("base64"), publicKey: signed.publicKey.toString(), signature: signed.signature } };
}
const DAO_KEY = generateKey().secretKey;

test("a DAO-owned market agent pays a hire only on its DAO's signed approval of the exact terms", async () => {
  const { approveHire } = await import("../src/market/hire.js");
  sim.register(KEY);
  sim.fund(KEY, "0");
  const before = process.env.HOSTED_OWNER_KIND;
  process.env.HOSTED_OWNER_KIND = "dao";
  mock.method(api, "getAgent", async () => ({ id: process.env.AGENT_ID, owner: { type: "near", account_id: "dao-signer.near", public_key: parseKey(DAO_KEY).publicKey.toString() } }));
  const context = { actor: "app:covenant:acme", host: "api.test" };
  try {
    const approved = await quoteHire({ handle: "writer", brief: BRIEF });
    await assert.rejects(hire(context.actor, { requestId: "d-0", brief: BRIEF, approved }), /dao_vote_required|approves each hire by vote/);
    // Another key, another host, another text, or an approval that ended: refused, with nothing sent.
    await assert.rejects(approveHire(context, await daoApproval({ key: generateKey().secretKey })), /isn't the agent's DAO owner's/);
    await assert.rejects(approveHire(context, await daoApproval({ host: "other.test" })), /isn't the agent's DAO owner's/);
    await assert.rejects(approveHire(context, await daoApproval({ text: "Approve anything" })), /isn't the agent's DAO owner's/);
    await assert.rejects(approveHire(context, await daoApproval({ validUntil: new Date(Date.now() - 1_000).toISOString() })),
      (error: unknown) => (error as { data?: { code?: string } }).data?.code === "approval_expired");
    const tampered = await daoApproval();
    await assert.rejects(approveHire(context, { ...tampered, approved: { ...tampered.approved, amount: "1" } }), /isn't the agent's DAO owner's/, "terms other than the ones signed");
    assert.equal(withdrawals.length, 0);
    assert.equal(readOps().length, 0);
    const paid = await approveHire(context, await daoApproval());
    assert.equal(paid.requestId, "d-1");
    assert.equal((await hireStatus(context.actor, "d-1")).state, "paid");
    // Relayed again: answered from the journal, nothing more paid.
    assert.equal((await approveHire(context, await daoApproval())).state, "paid");
    assert.equal(withdrawals.filter(w => w.asset === ASSETS.USDC).length, 1);
  } finally { if (before === undefined) delete process.env.HOSTED_OWNER_KIND; else process.env.HOSTED_OWNER_KIND = before; }
});

test("a wallet-owned agent's hires need no vote, and it refuses a DAO approval", async () => {
  const { approveHire } = await import("../src/market/hire.js");
  await assert.rejects(approveHire({ actor: "app:covenant:acme", host: "api.test" }, await daoApproval()), /isn't a DAO's/);
});

// The full hire, not just a shortfall withdrawal, must fit the owner's per-transaction ceiling.
for (const funding of ["unopened", "empty", "partial", "full"] as const) test(`an over-cap hire moves nothing with an ${funding} payment key`, async () => {
  sim.advance(1n); sim.chain.accounts.clear(); sim.register(KEY);
  if (funding !== "unopened") sim.fund(KEY, funding === "partial" ? "250000" : funding === "full" ? "500000" : "0");
  const policy = marketPolicy(KEY);
  policy.limits.per_transaction![ASSETS.USDC] = "250000";
  mock.method(api, "getPolicy", async () => policyView(policy));
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  await assert.rejects(hire(APP, { requestId: `cap-${funding}`, brief: BRIEF, approved }), /per.transaction|hire.*(cap|limit|ceiling)/i);
  assert.deepEqual(withdrawals, [], "refuse before even opening or topping up the key");
  assert.equal(readOps().length, 0, "preflight refusal records no money attempt");
  assert.equal(sim.chain.accounts.get(KEY)?.transfers.length ?? 0, 0);
});

test("the full hire ceiling is rechecked after a top-up before the payment is signed", async () => {
  sim.advance(1n); sim.chain.accounts.clear(); sim.register(KEY); sim.fund(KEY, "0");
  let ceiling = "500000";
  mock.method(api, "getPolicy", async () => {
    const policy = marketPolicy(KEY); policy.limits.per_transaction![ASSETS.USDC] = ceiling; return policyView(policy);
  });
  mock.method(api, "forGrant", () => ({ withdraw: async (_id: string, request: {asset: string; amount: string; recipient: string}, {idempotencyKey}: {idempotencyKey: string}) => {
    withdrawals.push({...request, key: idempotencyKey}); sim.fund(request.recipient, request.amount); ceiling = "250000";
    return {correlation_id: "topup-before-cap-change"};
  }}));
  const approved = await quoteHire({handle: "writer", brief: BRIEF});
  const result = await hire(APP, {requestId: "cap-tightened", brief: BRIEF, approved});
  assert.equal(result.state, "refused"); assert.equal(result.code, "per_transaction_exceeded");
  assert.equal(withdrawals.length, 1);
  assert.equal(sim.chain.accounts.get(KEY)!.balance, 500000n, "the completed top-up is retained");
  assert.equal(sim.chain.accounts.get(KEY)!.transfers.length, 0);
  assert.equal(readOps().find(op => op.idempotencyKey === requestKey(APP, "cap-tightened"))!.submissionState, "PREPARED");
});

test("a hire exactly at the full ceiling can use retained funds plus a shortfall", async () => {
  sim.advance(1n); sim.chain.accounts.clear(); sim.register(KEY); sim.fund(KEY, "250000");
  const policy = marketPolicy(KEY); policy.limits.per_transaction![ASSETS.USDC] = "500000";
  mock.method(api, "getPolicy", async () => policyView(policy));
  const approved = await quoteHire({handle: "writer", brief: BRIEF});
  await hire(APP, {requestId: "cap-equal", brief: BRIEF, approved});
  assert.equal((await hireStatus(APP, "cap-equal")).state, "paid");
  assert.deepEqual(withdrawals.map(w => w.amount), ["250000"]);
  assert.equal(sim.chain.accounts.get(KEY)!.transfers.length, 1);
});
