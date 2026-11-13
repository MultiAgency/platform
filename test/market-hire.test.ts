import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { after, beforeEach, mock, test } from "node:test";
import { generateKey, parseKey, Near } from "near-kit";
import lockfile from "proper-lockfile";
import { fundingContextFixture } from "./fixtures/funding-context.js";
import { MARKET_USDC, market } from "./e2e/market.mjs";

/**
 * A market hire through the real money path (docs/market.md): the money lock, the journal, `authorize`, the one send
 * site. The Agent API is a stand-in (its withdrawals land on the simulated chain); the market and the chain the
 * payment key lives on are simulated, on loopback.
 */

const sim = await market({ agents: {
  writer: { amount: "500000", windowSeconds: 600, outcome: "complete", result: "the article" },
  refuser: { amount: "500000", windowSeconds: 600, outcome: "reject" },
  closed: { amount: "500000", windowSeconds: 600, outcome: "closed" },
  invalid: { amount: "500000", windowSeconds: 600, outcome: "invalid" },
  broken: { amount: "500000", windowSeconds: 600, outcome: "broken" },
} });
const secretKey = generateKey().secretKey;
const KEY = Buffer.from(parseKey(secretKey).publicKey.data).toString("hex");
Object.assign(process.env, { MARKET_URL: sim.url, NEAR_RPC_URL: sim.rpc, MARKET_PAYMENT_KEY: secretKey, AGENT_GRANT_TOKEN: "ngt_fixture" });
// Read after the environment points at the simulators: chain.ts fixes its RPC endpoint on import.
const { api } = await import("../src/api.js");
const { readOps, readMarketBindings, marketStageKey } = await import("../src/ops.js");
const { ASSETS, marketPolicy } = await import("../src/policy.js");
const { hire, hireStatus, quoteHire, fundMarketOnly: observedFunding } = await import("../src/market/hire.js");
const { fundingProof } = await import("../src/market/funding-proof.js");
const { acquireMoneyLock, UnresolvedOperations } = await import("../src/lock.js");
const { requestKey } = await import("../src/payout-requests.js");
const { authorityFixture, fixtureGrant, policyView, timedPrices } = await import("./fixtures/authority.js");
const { freshDirectory } = await import("./fixtures/harness.js");

const APP = "app:covenant:acme";
const fundMarketOnly = (...args: Parameters<typeof observedFunding>) =>
  observedFunding(args[0], args[1], args[2], args[3] ?? fundingContextFixture(secretKey));
let withdrawals: { asset: string; amount: string; recipient: string; key: string }[];
let fundingProofAvailable: boolean;
let deliveredAmount: string | undefined;

freshDirectory("market-hire");
after(() => sim.close());
beforeEach(() => {
  withdrawals = [];
  fundingProofAvailable = true;
  deliveredAmount = undefined;
  for (const [name, method] of Object.entries(authorityFixture())) mock.method(api, name as keyof typeof api, method as never);
  const marketGrant = fixtureGrant("market");
  process.env.FIXTURE_MARKET_GRANT_EXPIRES = marketGrant.expires_at;
  mock.method(api, "listGrants", async () => [marketGrant]);
  mock.method(api, "getPolicy", async () => policyView(marketPolicy(KEY)));
  mock.method(api, "getTokens", async () => timedPrices([{ asset_id: ASSETS.USDC, symbol: "USDC", decimals: 6, price: 1 },
    { asset_id: ASSETS.wNEAR, symbol: "wNEAR", decimals: 24, price: 2 }]));
  mock.method(api, "getStatus", async (correlation_id: string) => {
    const index = correlation_id === "topup-before-cap-change" ? 0 : Number(correlation_id.replace("op_", "")) - 1;
    const withdrawal = withdrawals[index];
    return { correlation_id, type: "withdraw", status: "SUCCESS", details: withdrawal
      ? { destination_tx_hash: String(index + 1).padStart(44, "2"), amount_out: deliveredAmount ?? withdrawal.amount } : {} };
  });
  mock.method(fundingProof, "verify", async (input: { destinationTxHash?: string | null; recipient: string; asset: string; amount: string }) =>
    fundingProofAvailable ? { ...input, destinationTxHash: input.destinationTxHash!, blockHeight: sim.chain.height.toString() } : null);
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
  assert.deepEqual(withdrawals.map(w => w.key), [marketStageKey(requestKey(APP, "h-1"), "open"), marketStageKey(requestKey(APP, "h-1"), "usdc")]);
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

test("a successful top-up without destination proof needs review and rejects changed terms", async () => {
  sim.advance(1n); sim.chain.accounts.clear();
  sim.register(KEY); sim.fund(KEY, "0");
  fundingProofAvailable = false;
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  const first = await hire(APP, { requestId: "bound-funding", brief: BRIEF, approved });
  assert.equal(first.state, "funding_review");
  assert.equal((await hireStatus(APP, "bound-funding")).state, "funding_review");
  assert.equal(withdrawals.length, 1);
  assert.equal(sim.chain.accounts.get(KEY)!.transfers.length, 0, "no x402 payment while funding is unproved");
  const { dispatch } = await import("../src/agent.js");
  const lock = await acquireMoneyLock();
  try {
    await assert.rejects(dispatch(lock, "direct-key-send", { method: "withdraw", request: { asset: ASSETS.USDC,
      amount: "1", chain: "near", recipient: KEY, confidential: true } }), /funding_pending/);
  } finally { await lock.release(); }
  assert.equal(withdrawals.length, 1, "a direct on-platform send cannot bypass the pending funding guard");
  const binding = readMarketBindings().find(item => item.idempotencyKey === requestKey(APP, "bound-funding"))!;
  assert.equal(binding.paymentAccount, KEY);
  assert.equal(binding.brief, BRIEF);
  assert.deepEqual(binding.approved, approved);
  const otherBrief = `${BRIEF} Different work.`;
  const otherApproved = await quoteHire({ handle: "writer", brief: otherBrief });
  await assert.rejects(hire(APP, { requestId: "bound-funding", brief: otherBrief, approved: otherApproved }),
    (error: unknown) => (error as { data?: { code?: string } }).data?.code === "request_conflict");
  assert.equal(withdrawals.length, 1);
});

for (const stage of ["open", "usdc"] as const) test(`a ${stage} top-up whose acceptance reply is lost needs funding review without another send`, async () => {
  sim.advance(1n); sim.chain.accounts.clear(); sim.register(KEY);
  if (stage === "usdc") sim.fund(KEY, "0");
  mock.method(api, "forGrant", () => ({ withdraw: async (_id: string,
    request: { asset: string; amount: string; recipient: string }, { idempotencyKey }: { idempotencyKey: string }) => {
    withdrawals.push({ ...request, key: idempotencyKey });
    // The provider accepted and credited the exact original withdrawal before losing its HTTP reply.
    sim.fund(request.recipient, request.asset === ASSETS.USDC ? request.amount : "0");
    throw new Error("fixture drops the accepted withdrawal reply");
  } }));
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  const requestId = `lost-${stage}-acceptance`, bindingKey = requestKey(APP, requestId);
  const result = await hire(APP, { requestId, brief: BRIEF, approved });
  const op = readOps().find(item => item.idempotencyKey === marketStageKey(bindingKey, stage));
  assert.equal(op?.submissionState, "SUBMISSION_ATTEMPTED", "the send claim reached the real journal");
  assert.equal(op?.correlationId, undefined, "the provider's identity was in the lost reply");
  assert.equal(op?.status, undefined);
  assert.equal(withdrawals.length, 1);
  assert.equal(sim.chain.accounts.get(KEY)!.balance, stage === "usdc" ? BigInt(approved.amount) : 0n,
    "the unknown outcome follows an accepted fixture credit, not a refusal before I/O");
  assert.equal(result.state, "funding_review");
  assert.equal(result.code, "funding_review_required");
  const recorded = readOps();
  assert.equal((await hireStatus(APP, requestId)).state, "funding_review");
  assert.equal((await hire(APP, { requestId, brief: BRIEF, approved })).state, "funding_review");
  await assert.rejects(acquireMoneyLock(), error => error instanceof UnresolvedOperations);
  await assert.rejects(hire(APP, { requestId: `${requestId}-other`, brief: BRIEF, approved }));
  assert.deepEqual(readOps(), recorded, "status and retries cannot replace or infer a funding outcome");
  assert.equal(withdrawals.length, 1, "the original or another request never replays the unknown funding");
  assert.equal(sim.chain.accounts.get(KEY)!.transfers.length, 0);
});

test("an in-flight preparation stays funding and a proven refusal stays refused after its claim", async () => {
  sim.advance(1n); sim.chain.accounts.clear(); sim.register(KEY); sim.fund(KEY, "0");
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  const requestId = "local-funding-preparation", bindingKey = requestKey(APP, requestId);
  const { record, recordMarketBinding, claimSubmission } = await import("../src/ops.js");
  const { marketFundingNeedsReview } = await import("../src/market/binding-guard.js");
  const request = { asset: ASSETS.USDC, amount: approved.amount, chain: "near", recipient: KEY, confidential: true };
  const stageKey = marketStageKey(bindingKey, "usdc");
  const lock = await acquireMoneyLock();
  try {
    recordMarketBinding({ idempotencyKey: bindingKey, actor: APP, requestId, brief: BRIEF, approved,
      paymentAccount: KEY, publicKey: parseKey(secretKey).publicKey.toString() });
    record({ at: new Date().toISOString(), idempotencyKey: stageKey, kind: "market-topup", method: "withdraw", journalVersion: 2, request });
    // Another read cannot retire the preparation while its money-lock holder is still running.
    assert.equal((await hireStatus(APP, requestId)).state, "funding");
    assert.equal(marketFundingNeedsReview(readMarketBindings()[0]!, readOps()), false);
    claimSubmission(stageKey, request);
    record({ idempotencyKey: stageKey, refused: "approval_expired" });
    assert.equal((await hireStatus(APP, requestId)).state, "refused");
    assert.equal(marketFundingNeedsReview(readMarketBindings()[0]!, readOps()), false,
      "a proven local refusal is not an unknown acceptance");
  } finally { await lock.release(); }
  assert.equal(withdrawals.length, 0);
  assert.equal(sim.chain.accounts.get(KEY)!.transfers.length, 0);
});

test("an unproved top-up reserves the payment key across request IDs", async () => {
  sim.advance(1n); sim.chain.accounts.clear();
  sim.register(KEY); sim.fund(KEY, "0");
  fundingProofAvailable = false;
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  assert.equal((await hire(APP, { requestId: "reserve-one", brief: BRIEF, approved })).state, "funding_review");
  assert.equal(withdrawals.length, 1);
  const second = await hire(APP, { requestId: "reserve-two", brief: BRIEF, approved });
  assert.equal(second.state, "funding");
  assert.equal(withdrawals.length, 1, "no duplicate top-up for the same shared payment key");
  assert.equal(sim.chain.accounts.get(KEY)!.transfers.length, 0, "no x402 while the earlier top-up may land");
});

test("a status read records late funding proof and a retry uses the original stage without another withdrawal", async () => {
  sim.advance(1n); sim.chain.accounts.clear(); sim.register(KEY); sim.fund(KEY, "0");
  fundingProofAvailable = false;
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  assert.equal((await hire(APP, { requestId: "late-proof", brief: BRIEF, approved })).state, "funding_review");
  assert.equal(withdrawals.length, 1);
  fundingProofAvailable = true;
  assert.equal((await hireStatus(APP, "late-proof")).state, "funding_review");
  assert.ok(readMarketBindings().find(item => item.idempotencyKey === requestKey(APP, "late-proof"))?.landed.usdc);
  assert.equal((await hire(APP, { requestId: "late-proof", brief: BRIEF, approved })).state, "unknown");
  assert.equal(withdrawals.length, 1, "the completed funding stage was followed, not repeated");
  assert.equal((await hireStatus(APP, "late-proof")).state, "paid");
});

test("a proven local top-up refusal leaves a refused request and no key-wide funding reservation", async () => {
  sim.advance(1n); sim.chain.accounts.clear(); sim.register(KEY); sim.fund(KEY, "0");
  let policyReads = 0;
  mock.method(api, "getPolicy", async () => {
    const policy = marketPolicy(KEY);
    if (++policyReads > 1) policy.limits.per_transaction![ASSETS.USDC] = "250000";
    return policyView(policy);
  });
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  const result = await hire(APP, { requestId: "local-topup-refusal", brief: BRIEF, approved });
  assert.equal(result.state, "refused");
  assert.equal((await hireStatus(APP, "local-topup-refusal")).state, "refused");
  assert.equal(withdrawals.length, 0);
  const { pendingMarketFunding } = await import("../src/market/binding-guard.js");
  assert.equal(pendingMarketFunding(KEY), null);
});

for (const refusedStage of ["open", "usdc"] as const) test(`dispatch cannot continue a hire after its ${refusedStage} funding stage was locally refused`, async () => {
  sim.advance(1n); sim.chain.accounts.clear(); sim.register(KEY);
  if (refusedStage === "usdc") sim.fund(KEY, "0");
  let policyReads = 0;
  mock.method(api, "getPolicy", async () => {
    const policy = marketPolicy(KEY);
    if (++policyReads > 1) policy.limits.per_transaction![ASSETS.USDC] = "250000";
    return policyView(policy);
  });
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  const requestId = `closed-${refusedStage}`, bindingKey = requestKey(APP, requestId);
  assert.equal((await hire(APP, { requestId, brief: BRIEF, approved })).state, "refused");
  assert.equal(readOps().find(op => op.idempotencyKey === marketStageKey(bindingKey, refusedStage))?.refused,
    "per_transaction_exceeded");
  mock.method(api, "getPolicy", async () => policyView(marketPolicy(KEY)));
  sim.fund(KEY, "0");
  const { dispatch } = await import("../src/agent.js");
  const { OPEN_ACCOUNT_WNEAR } = await import("../src/market/x402.js");
  const before = readOps();
  const lock = await acquireMoneyLock();
  try {
    // A different stage has a fresh operation identity, so duplicate-preparation checks cannot close this path.
    const nextStage = refusedStage === "open" ? "usdc" : "open";
    await assert.rejects(dispatch(lock, "market-topup", { method: "withdraw", request: {
      asset: nextStage === "open" ? ASSETS.wNEAR : ASSETS.USDC,
      amount: nextStage === "open" ? OPEN_ACCOUNT_WNEAR : approved.amount,
      chain: "near", recipient: KEY, confidential: true,
    } }, undefined, undefined, undefined, marketStageKey(bindingKey, nextStage), undefined,
    { hire: approved, bindingKey, stage: nextStage }), /market_binding_closed/);
    // Even a fully funded key cannot pay the closed hire through a direct dispatch call.
    sim.fund(KEY, approved.amount);
    await assert.rejects(dispatch(lock, "market-hire", { method: "x402", request: {
      handle: approved.handle, brief: BRIEF, messageId: crypto.randomUUID(),
      row: { scheme: "exact", network: approved.network, asset: approved.asset, amount: approved.amount,
        payTo: approved.payTo, maxTimeoutSeconds: approved.maxTimeoutSeconds },
      asset: ASSETS.USDC, amount: approved.amount, payer: KEY, publicKey: parseKey(secretKey).publicKey.toString(),
      nonce: "1", maxBlockHeight: (sim.chain.height + 1_200n).toString(), balanceAtSigning: approved.amount,
    } }, undefined, undefined, undefined, bindingKey, undefined, { hire: approved, bindingKey }), /market_binding_closed/);
  } finally { await lock.release(); }
  assert.deepEqual(readOps(), before, "neither rejected dispatch prepares another operation");
  assert.equal(withdrawals.length, 0);
  assert.equal(sim.chain.accounts.get(KEY)!.transfers.length, 0);
  assert.equal((await hire(APP, { requestId, brief: BRIEF, approved })).state, "refused");
  const otherId = `${requestId}-other`;
  assert.equal((await hire(APP, { requestId: otherId, brief: BRIEF, approved })).state, "unknown");
  assert.equal((await hireStatus(APP, otherId)).state, "paid", "terminal closure does not reserve the key against other hires");
  assert.equal(withdrawals.length, 0, "the other hire can use the retained fixture balance");
  assert.equal(sim.chain.accounts.get(KEY)!.transfers.length, 1);
});

test("a fee-short top-up closes its request atomically with landing proof, leaving funds on the key", async () => {
  sim.advance(1n); sim.chain.accounts.clear(); sim.register(KEY); sim.fund(KEY, "0");
  deliveredAmount = "490000";
  mock.method(api, "forGrant", () => ({ withdraw: async (_id: string, request: { asset: string; amount: string; recipient: string },
    { idempotencyKey }: { idempotencyKey: string }) => {
    withdrawals.push({ ...request, key: idempotencyKey });
    sim.fund(request.recipient, deliveredAmount!);
    return { correlation_id: "op_1" };
  } }));
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  const result = await hire(APP, { requestId: "fee-short", brief: BRIEF, approved });
  assert.equal(result.state, "refused");
  assert.equal(result.code, "funding_shortfall");
  assert.equal((await hireStatus(APP, "fee-short")).state, "refused");
  assert.equal(withdrawals.length, 1);
  assert.equal(sim.chain.accounts.get(KEY)!.transfers.length, 0);
  const binding = readMarketBindings().find(item => item.idempotencyKey === requestKey(APP, "fee-short"));
  assert.ok(binding?.landed.usdc);
  assert.equal(binding?.refused, "funding_shortfall", "landing and refusal are one durable journal record");
  assert.equal((await hire(APP, { requestId: "fee-short", brief: BRIEF, approved })).state, "refused");
});

test("a failed submitted top-up remains reserved for review across request IDs", async () => {
  sim.advance(1n); sim.chain.accounts.clear(); sim.register(KEY); sim.fund(KEY, "0");
  mock.method(api, "forGrant", () => ({ withdraw: async (_id: string, request: { asset: string; amount: string; recipient: string },
    { idempotencyKey }: { idempotencyKey: string }) => {
    withdrawals.push({ ...request, key: idempotencyKey });
    return { correlation_id: "op_1" };
  } }));
  mock.method(api, "getStatus", async (correlation_id: string) =>
    ({ correlation_id, type: "withdraw", status: "FAILED", failure_code: "route_failed", details: {} }));
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  assert.equal((await hire(APP, { requestId: "failed-funding", brief: BRIEF, approved })).state, "funding_review");
  assert.equal((await hireStatus(APP, "failed-funding")).state, "funding_review");
  assert.equal((await hire(APP, { requestId: "after-failed", brief: BRIEF, approved })).state, "funding");
  assert.equal(withdrawals.length, 1, "a terminal provider failure alone cannot authorize replacement funding");
  assert.equal(sim.chain.accounts.get(KEY)!.transfers.length, 0);
});

test("a hire pays only the terms approved: a changed quote or another brief is refused, with nothing sent", async () => {
  sim.register(KEY);
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  await assert.rejects(hire(APP, { requestId: "h-2", brief: BRIEF, approved: { ...approved, amount: "400000" } }), /quote_changed|terms changed/);
  await assert.rejects(hire(APP, { requestId: "h-3", brief: `${BRIEF}!`, approved }), /isn't the one approved/);
  assert.deepEqual(withdrawals, []);
  assert.equal(readOps().length, 0);
});

test("overlapping hires with one requestId refuse different terms even after the other records payment", async t => {
  sim.advance(1n); sim.chain.accounts.clear(); sim.register(KEY); sim.fund(KEY, "500000");
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  const otherBrief = `${BRIEF} Different work.`;
  const otherApproved = await quoteHire({ handle: "writer", brief: otherBrief });
  let enteredFirst!: () => void, releaseFirst!: () => void, enteredSecond!: () => void, releaseSecond!: () => void;
  const firstInPolicy = new Promise<void>(resolve => { enteredFirst = resolve; });
  const firstMayContinue = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondAtLock = new Promise<void>(resolve => { enteredSecond = resolve; });
  const secondMayFail = new Promise<void>(resolve => { releaseSecond = resolve; });
  let policyReads = 0, lockCalls = 0;
  t.mock.method(api, "getPolicy", async () => {
    if (++policyReads === 1) { enteredFirst(); await firstMayContinue; }
    return policyView(marketPolicy(KEY));
  });
  const actualLock = lockfile.lock;
  t.mock.method(lockfile, "lock", (file: string, options: Parameters<typeof lockfile.lock>[1]) => {
    if (++lockCalls === 2) { enteredSecond(); return secondMayFail.then(() => { throw Object.assign(new Error("busy"), { code: "ELOCKED" }); }); }
    return actualLock(file, options);
  });
  const first = hire(APP, { requestId: "overlap", brief: BRIEF, approved });
  await firstInPolicy;
  const second = hire(APP, { requestId: "overlap", brief: otherBrief, approved: otherApproved });
  try {
    // The second call has passed its initial journal lookup but cannot acquire the first call's money lock.
    await secondAtLock;
    releaseFirst();
    assert.equal((await first).state, "unknown");
    releaseSecond();
    await assert.rejects(second, (error: unknown) => (error as { data?: { code?: string } }).data?.code === "request_conflict");
    assert.equal(readOps().filter(op => op.method === "x402" && op.idempotencyKey === requestKey(APP, "overlap")).length, 1);
    assert.equal(sim.chain.accounts.get(KEY)!.transfers.length, 1);
    assert.deepEqual(withdrawals, []);
  } finally { releaseFirst(); releaseSecond(); }
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

// #66: an agent the market doesn't list, or one not taking calls, is refused with a code, never `unavailable`, which
// tells an app to send the same call again. Any other market error is not mistaken for one of these.
test("a quote for an unlisted agent, or one not taking calls, is refused with a code and sends nothing", async () => {
  const code = (error: unknown) => (error as { data?: { code?: string } }).data?.code;
  await assert.rejects(quoteHire({ handle: "nosuchagent", brief: BRIEF }), (error: unknown) => code(error) === "agent_not_found");
  await assert.rejects(quoteHire({ handle: "closed", brief: BRIEF }), (error: unknown) => code(error) === "agent_not_hireable");
  await assert.rejects(quoteHire({ handle: "invalid", brief: BRIEF }), (error: unknown) => code(error) === "quote_refused");
  await assert.rejects(quoteHire({ handle: "broken", brief: BRIEF }), (error: unknown) => code(error) === undefined && /-32603/.test(String(error)));
  sim.register(KEY);
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  await assert.rejects(hire(APP, { requestId: "h-gone", brief: BRIEF, approved: { ...approved, handle: "nosuchagent" } }), (error: unknown) => code(error) === "agent_not_found");
  await assert.rejects(hire(APP, { requestId: "h-closed", brief: BRIEF, approved: { ...approved, handle: "closed" } }), (error: unknown) => code(error) === "agent_not_hireable");
  assert.equal(withdrawals.length, 0);
  assert.equal(readOps().length, 0);
});



test("funding-only observation never calls Market or pays, persists its mode, and reserves the key", async () => {
  sim.advance(1n); sim.chain.accounts.clear(); sim.register(KEY); sim.fund(KEY, "0");
  const approved = { ...(await quoteHire({ handle: "writer", brief: BRIEF })), amount: "10000" };
  const input = { requestId: "proof-only", brief: BRIEF, approved };
  const calls = sim.calls.length;
  mock.method(Near.prototype, "transaction", () => { throw new Error("funding must never sign a delegate"); });
  const deadline = Date.now() + 60_000;
  assert.equal((await fundMarketOnly(APP, input, deadline)).state, "funded");
  assert.deepEqual(withdrawals.map(w => [w.asset, w.amount]), [[ASSETS.USDC, "10000"]]);
  assert.equal(sim.calls.slice(calls).filter(c => c.path.includes("/a2a/") || c.payment !== null).length, 0, "no Market quote or paid call");
  assert.equal(sim.chain.accounts.get(KEY)!.transfers.length, 0);
  assert.equal(readOps().some(o => o.method === "x402"), false);
  assert.equal(readMarketBindings().find(b => b.requestId === input.requestId)?.fundingOnly, true, "mode survives journal reread");
  assert.equal((await fundMarketOnly(APP, input, deadline)).state, "funded");
  assert.equal(withdrawals.length, 1, "same stage is never submitted twice");
  await assert.rejects(hire(APP, input), /cannot change/);
  await assert.rejects(fundMarketOnly(APP, { ...input, approved: { ...approved, amount: "10001" } }, deadline), /another hire/);
  assert.equal(withdrawals.length, 1);
  assert.equal((await hire(APP, { ...input, requestId: "consume-proof", approved: { ...approved, amount: "500000" } })).state, "funding");
  assert.equal(withdrawals.length, 1, "another request cannot consume reserved observation funds");
});

test("funding-only SUCCESS without a receipt stays in review and never pays on repeated reads", async () => {
  sim.advance(1n); sim.chain.accounts.clear(); sim.register(KEY); sim.fund(KEY, "0");
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  fundingProofAvailable = false;
  const input = { requestId: "proof-no-receipt", brief: BRIEF, approved };
  for (let i = 0; i < 2; i++) assert.equal((await fundMarketOnly(APP, input, Date.now() + 60_000)).state, "funding_review");
  assert.equal((await hireStatus(APP, input.requestId)).state, "funding_review");
  assert.equal(withdrawals.length, 1);
  assert.equal(sim.chain.accounts.get(KEY)!.transfers.length, 0);
  await assert.rejects(hire(APP, input), /cannot change/);
});

test("funding-only lost submission reply remains unresolved with one withdrawal", async () => {
  sim.advance(1n); sim.chain.accounts.clear(); sim.register(KEY); sim.fund(KEY, "0");
  mock.method(api, "forGrant", () => ({ withdraw: async (_id: string, request: { asset: string; amount: string; recipient: string }, { idempotencyKey }: { idempotencyKey: string }) => {
    withdrawals.push({ ...request, key: idempotencyKey });
    sim.fund(request.recipient, request.amount);
    throw new Error("lost accepted reply");
  } }));
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  const input = { requestId: "proof-lost", brief: BRIEF, approved };
  assert.equal((await fundMarketOnly(APP, input, Date.now() + 60_000)).state, "funding_review");
  await fundMarketOnly(APP, input, Date.now() + 60_000);
  assert.equal(withdrawals.length, 1);
  assert.equal(readOps().find(o => o.kind === "market-topup")?.submissionState, "SUBMISSION_ATTEMPTED");
  assert.equal(readOps().some(o => o.method === "x402"), false);
});

test("funding-only requires a live explicit approval deadline", async () => {
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  const input = { requestId: "proof-expired", brief: BRIEF, approved };
  await assert.rejects(fundMarketOnly(APP, input, Number.NaN), /explicit approval deadline/);
  await assert.rejects(fundMarketOnly(APP, input, Date.now() - 1), /approval expired/);
  assert.equal(withdrawals.length, 0);
});


test("dispatch independently blocks an x402 action for a funding-only binding", async () => {
  sim.advance(1n); sim.chain.accounts.clear(); sim.register(KEY); sim.fund(KEY, "0");
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  const requestId = "proof-dispatch", bindingKey = requestKey(APP, requestId);
  await fundMarketOnly(APP, { requestId, brief: BRIEF, approved }, Date.now() + 60_000);
  const { dispatch } = await import("../src/agent.js");
  const lock = await acquireMoneyLock();
  try {
    await assert.rejects(dispatch(lock, "market-hire", { method: "x402", request: {
      handle: approved.handle, brief: BRIEF, messageId: crypto.randomUUID(),
      row: { scheme: "exact", network: approved.network, asset: approved.asset, amount: approved.amount,
        payTo: approved.payTo, maxTimeoutSeconds: approved.maxTimeoutSeconds },
      asset: ASSETS.USDC, amount: approved.amount, payer: KEY, publicKey: parseKey(secretKey).publicKey.toString(),
      nonce: "1", maxBlockHeight: (sim.chain.height + 1_200n).toString(), balanceAtSigning: approved.amount,
    } }, undefined, undefined, undefined, bindingKey, undefined, { hire: approved, bindingKey }), /funding_only/);
  } finally { await lock.release(); }
  assert.equal(readOps().some(o => o.method === "x402"), false);
});

test("a short-delivered funding observation remains reserved after a terminal binding refusal", async () => {
  sim.advance(1n); sim.chain.accounts.clear(); sim.register(KEY); sim.fund(KEY, "0");
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  mock.method(api, "forGrant", () => ({ withdraw: async (_id: string, request: { asset: string; amount: string; recipient: string }, { idempotencyKey }: { idempotencyKey: string }) => {
    withdrawals.push({ ...request, key: idempotencyKey }); sim.fund(request.recipient, "1");
    return { correlation_id: "op_1" };
  } }));
  deliveredAmount = "1";
  const input = { requestId: "proof-short", brief: BRIEF, approved };
  assert.equal((await fundMarketOnly(APP, input, Date.now() + 60_000)).state, "refused");
  const { pendingMarketFunding } = await import("../src/market/binding-guard.js");
  assert.ok(pendingMarketFunding(KEY), "a successful proof does not authorize residual reuse");
  assert.equal((await hire(APP, { ...input, requestId: "consume-short-proof" })).state, "funding");
  assert.equal(withdrawals.length, 1);
});

test("a funding observation rejects a key with retained USDC before writing its binding", async () => {
  sim.advance(1n); sim.chain.accounts.clear(); sim.register(KEY); sim.fund(KEY, "1");
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  await assert.rejects(fundMarketOnly(APP, { requestId: "proof-reused", brief: BRIEF, approved }, Date.now() + 60_000), /unused isolated/);
  assert.equal(readMarketBindings().length, 0);
  assert.equal(withdrawals.length, 0);
});


test("funding-only rechecks the durable wallet owner at the provider before sending", async () => {
  sim.advance(1n); sim.chain.accounts.clear(); sim.register(KEY); sim.fund(KEY, "0");
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  const original = (await api.getAgent(process.env.AGENT_ID!));
  mock.method(api, "getAgent", async () => ({ ...original, owner: { type: "near" as const, account_id: "other.near", public_key: "ed25519:fixture" } }));
  await assert.rejects(fundMarketOnly(APP, { requestId: "proof-owner-changed", brief: BRIEF, approved }, Date.now() + 60_000), /reviewed active wallet owner/);
  assert.equal(withdrawals.length, 0);
  assert.equal(readMarketBindings().length, 0);
});

test("missing funding context refuses instead of inferring wallet ownership from absent runtime variables", async () => {
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  await assert.rejects(observedFunding(APP, { requestId: "proof-no-context", brief: BRIEF, approved }, Date.now() + 60_000));
  assert.equal(withdrawals.length, 0);
  assert.equal(readMarketBindings().length, 0);
});


test("a registry owner-kind change after opening stops the next funding stage and retains the original opening", async () => {
  sim.advance(1n); sim.chain.accounts.clear(); sim.register(KEY);
  const context = fundingContextFixture(secretKey);
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  mock.method(api, "forGrant", () => ({ withdraw: async (_id: string, request: { asset: string; amount: string; recipient: string }, { idempotencyKey }: { idempotencyKey: string }) => {
    withdrawals.push({ ...request, key: idempotencyKey });
    sim.fund(request.recipient, "0");
    const registry = `${context.stateDirectory}/.hosted/apps.json`;
    const value = JSON.parse(readFileSync(registry, "utf8"));
    value.entries[0].kind = "dao";
    writeFileSync(registry, JSON.stringify(value));
    return { correlation_id: "op_1" };
  } }));
  await assert.rejects(fundMarketOnly(APP, { requestId: "proof-owner-during-opening", brief: BRIEF, approved }, Date.now() + 60_000, context), /durable wallet-owner reservation/);
  assert.deepEqual(withdrawals.map(w => w.asset), [ASSETS.wNEAR]);
  assert.equal(readOps().some(o => o.method === "x402"), false);
  const { pendingMarketFunding } = await import("../src/market/binding-guard.js");
  assert.ok(pendingMarketFunding(KEY), "owner-context failure never clears the already funded stage");
});


test("a lost locked owner-context read cannot report an earlier landed request as funded", async () => {
  sim.advance(1n); sim.chain.accounts.clear(); sim.register(KEY); sim.fund(KEY, "0");
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  const input = { requestId: "proof-owner-read-lost", brief: BRIEF, approved };
  assert.equal((await fundMarketOnly(APP, input, Date.now() + 60_000)).state, "funded");
  const agent = await api.getAgent(process.env.AGENT_ID!);
  let reads = 0;
  mock.method(api, "getAgent", async () => {
    if (++reads === 2) throw new Error("owner evidence read unavailable");
    return agent;
  });
  await assert.rejects(fundMarketOnly(APP, input, Date.now() + 60_000), /Funding context is unavailable/);
  assert.equal(withdrawals.length, 1);
  assert.equal(readOps().some(o => o.method === "x402"), false);
});

test("funding observation refuses a different reviewed policy before submitting", async () => {
  sim.advance(1n); sim.chain.accounts.clear(); sim.register(KEY); sim.fund(KEY, "0");
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  const context = { ...fundingContextFixture(secretKey), reviewedPolicy: { revision: 999, digest: `sha256:${"0".repeat(64)}` } };
  await assert.rejects(observedFunding(APP, { requestId: "proof-policy-pin", brief: BRIEF, approved }, Date.now() + 60_000, context), /reviewed policy/i);
  assert.equal(withdrawals.length, 0);
});

test("funding observation refuses a different reviewed grant before submitting", async () => {
  sim.advance(1n); sim.chain.accounts.clear(); sim.register(KEY); sim.fund(KEY, "0");
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  const context = { ...fundingContextFixture(secretKey), reviewedGrant: { id: "another-grant", expiresAt: new Date(Date.now() + 60_000).toISOString() } };
  await assert.rejects(observedFunding(APP, { requestId: "proof-grant-pin", brief: BRIEF, approved }, Date.now() + 60_000, context), /reviewed grant/i);
  assert.equal(withdrawals.length, 0);
});


for (const changed of ["policy", "grant"] as const) test(`funding dispatch refuses a ${changed} change during asynchronous preflight`, async () => {
  sim.advance(1n); sim.chain.accounts.clear(); sim.register(KEY); sim.fund(KEY, "0");
  const approved = await quoteHire({ handle: "writer", brief: BRIEF });
  const context = fundingContextFixture(secretKey);
  const grant = (await api.listGrants(process.env.AGENT_ID!))[0]!;
  let dispatchReading = false;
  mock.method(api, "getTokens", async () => {
    dispatchReading = true;
    return timedPrices([{ asset_id: ASSETS.USDC, symbol: "USDC", decimals: 6, price: 1 }]);
  });
  mock.method(api, "getPolicy", async () => {
    await Promise.resolve();
    const view = policyView(marketPolicy(KEY));
    return changed === "policy" && dispatchReading ? { ...view, revision: 2 } : view;
  });
  mock.method(api, "listGrants", async () => [changed === "grant" && dispatchReading ? { ...grant, grant_id: "substituted-grant" } : grant]);
  const result = await observedFunding(APP, { requestId: `proof-dispatch-${changed}`, brief: BRIEF, approved }, Date.now() + 60_000, context);
  assert.equal(result.state, "refused");
  assert.equal(result.code, changed === "policy" ? "reviewed_policy_changed" : "reviewed_grant_changed");
  assert.equal(withdrawals.length, 0);
});
