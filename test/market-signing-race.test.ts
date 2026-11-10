import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { writeFileSync } from "node:fs";
import { generateKey, parseKey, TransactionBuilder } from "near-kit";
import { MARKET_USDC, market } from "./e2e/market.mjs";
import type { Action } from "../src/agent.js";
import type { MoneyLock } from "../src/lock.js";

// The signing await can yield to shutdown or lost ownership. Exercise the real signer, dispatch, journal and market;
// the fault happens after signing returns, before a valid payment header could leave this process.
const sim = await market({ agents: { writer: { amount: "500000", windowSeconds: 600, outcome: "complete", result: "article" } } });
Object.assign(process.env, { MARKET_URL: sim.url, NEAR_RPC_URL: sim.rpc, AGENT_GRANT_TOKEN: "ngt_fixture" });
const { api } = await import("../src/api.js");
const { dispatch } = await import("../src/agent.js");
const { acquireMoneyLock, stopSending, resumeSendingForTests } = await import("../src/lock.js");
const { readOps } = await import("../src/ops.js");
const { ASSETS, marketPolicy } = await import("../src/policy.js");
const { challenge, message, payees } = await import("../src/market/client.js");
const { readChainView } = await import("../src/market/resolution.js");
const { paymentExpiry, quoteTerms } = await import("../src/market/x402.js");
const { authorityFixture, fixtureGrant, policyView, timedPrices } = await import("./fixtures/authority.js");
const { freshDirectory } = await import("./fixtures/harness.js");

freshDirectory("market-signing-race");
after(() => sim.close());
afterEach(() => resumeSendingForTests());
beforeEach(() => resumeSendingForTests());

const faults: { name: string; apply: (lock: MoneyLock) => void | Promise<void> }[] = [
  { name: "shutdown", apply: () => stopSending() },
  { name: "lost money-lock ownership", apply: lock => lock.release() },
  { name: "durable release", apply: () => writeFileSync(".env", `RELEASED_AT=${new Date().toISOString()}\n`) },
  { name: "provider restoration still required", apply: () => writeFileSync(".env", `RESTORE_REQUIRED=${process.env.AGENT_ID}\n`) },
];

for (const fault of faults) test(`x402 signing followed by ${fault.name} never claims or submits the payment`, async t => {
  const secret = generateKey().secretKey;
  process.env.MARKET_PAYMENT_KEY = secret;
  const pair = parseKey(secret), account = Buffer.from(pair.publicKey.data).toString("hex"), publicKey = pair.publicKey.toString();
  sim.register(account);
  sim.fund(account, "500000");
  for (const [name, method] of Object.entries(authorityFixture())) t.mock.method(api, name as keyof typeof api, method as never);
  t.mock.method(api, "listGrants", async () => [fixtureGrant("market")]);
  t.mock.method(api, "getPolicy", async () => policyView(marketPolicy(account)));
  t.mock.method(api, "getTokens", async () => timedPrices([{ asset_id: ASSETS.USDC, symbol: "USDC", decimals: 6, price: 1 }]));
  t.mock.method(api, "forGrant", () => ({} as never));
  const brief = "An article", messageId = crypto.randomUUID();
  const quote = quoteTerms({ handle: "writer", brief, challenge: await challenge("writer", message(messageId, brief)),
    payees: await payees(), maxWindowSeconds: 3_600 });
  assert.ok("terms" in quote);
  const view = await readChainView(account, publicKey, MARKET_USDC);
  const action: Extract<Action, { method: "x402" }> = { method: "x402", request: { handle: "writer", brief, messageId, row: quote.row,
    asset: ASSETS.USDC, amount: quote.terms.amount, payer: account, publicKey, nonce: (view.keyNonce! + 1n).toString(),
    maxBlockHeight: paymentExpiry(view.height, quote.terms).toString(), balanceAtSigning: view.balance.toString() } };
  const lock = await acquireMoneyLock();
  const delegate = TransactionBuilder.prototype.delegate;
  let signedCount = 0;
  t.mock.method(TransactionBuilder.prototype, "delegate", async function(this: TransactionBuilder, ...args: Parameters<typeof delegate>) {
    const signed = await delegate.apply(this, args);
    signedCount++;
    await fault.apply(lock);
    return signed;
  });
  const callsBefore = sim.calls.filter(c => c.payment !== null).length;
  try {
    await assert.rejects(dispatch(lock, "market-hire", action, undefined, undefined, undefined, undefined, undefined, { hire: quote.terms }));
    assert.equal(signedCount, 1, "the fault is injected only after the real signer completed");
    assert.equal(sim.calls.filter(c => c.payment !== null).length, callsBefore, "the signed header must never be sent");
    assert.equal(sim.chain.accounts.get(account)!.transfers.length, 0);
    const [op] = readOps();
    assert.equal(op?.submissionState, "PREPARED", "the payment must remain never submitted");
    assert.equal(op?.correlationId, undefined);
  } finally { await lock.release(); }
});
