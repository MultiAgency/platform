import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { AgentApiError } from "@near-intents-agent-api/sdk";
import { createRouterClient, ORPCError } from "@orpc/server";
import { api } from "../src/api.js";
import { dispatch } from "../src/agent.js";
import { withMoneyLock } from "../src/lock.js";
import { executePlan, observe, savePlan, type Plan, type PlanEvent, type PlannedAction } from "../src/plans.js";
import { ASSETS, treasuryPolicy } from "../src/policy.js";
import { claimSubmission, readOps, record, submittedSwapValues, type Method } from "../src/ops.js";
import { router } from "../src/router.js";
import { loadStrategy, saveStrategy } from "../src/strategy.js";
import { withinRunCeiling } from "../src/strategy-value.js";
import { authorityFixture, balanceView, marketTokens, policyView, quoteAt, timedPrices } from "./fixtures/authority.js";
import { freshDirectory, offline } from "./fixtures/harness.js";

const input = ASSETS.USDC, output = ASSETS.wNEAR;
let balances: Record<string, { public: bigint; confidential: bigint }>;
let sends: string[];
let price: number;
let priceReads: number;
let afterSend: () => void;
let prices: () => ReturnType<typeof timedPrices<{ asset_id: string; symbol: string; decimals: number; price: number }>>;
type SwapRequest = { origin_asset: string; destination_asset: string; amount: string };
/**
 * The provider's quote. The whole-number tests move only the input's valuation price, so by default a quote is 1:1 in
 * raw units; the market-price tests quote at the listed prices.
 */
let quote: (request: SwapRequest) => { amount_out: string; min_amount_out: string };
freshDirectory("planning-valuation");
beforeEach(() => {
  offline();
  process.env.AGENT_GRANT_TOKEN = "ngt_test";
  balances = Object.fromEntries(Object.values(ASSETS).map(asset => [asset, { public: 0n, confidential: 20n }]));
  sends = []; price = 1; priceReads = 0; afterSend = () => {};
  quote = request => ({ amount_out: request.amount, min_amount_out: request.amount });
  prices = () => timedPrices(Object.entries(ASSETS).map(([symbol, asset_id]) => ({
    symbol, asset_id, decimals: 0, price: asset_id === input ? price : 1,
  })));
  const strategy = loadStrategy();
  saveStrategy({ ...strategy, autopilot: { ...strategy.autopilot, maxUsd: 10 } });
  const authority = authorityFixture("treasury");
  mock.method(api, "listGrants", authority.listGrants);
  mock.method(api, "getPolicy", async () => policyView(treasuryPolicy));
  mock.method(api, "getTokens", async () => { priceReads++; return prices(); });
  mock.method(api, "getBalances", async (_id: string, { source }: { source: "public" | "confidential" }) =>
    balanceView(source, Object.entries(balances).map(([asset_id, balance]) => ({ asset_id, balance_raw: String(balance[source]) }))));
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, status: "SUCCESS" }));
  mock.method(api, "forGrant", () => ({
    shield: async (_id: string, request: { asset: string; amount: string }) => {
      sends.push("shield");
      balances[request.asset]!.public -= BigInt(request.amount);
      balances[request.asset]!.confidential += BigInt(request.amount);
      afterSend();
      return { correlation_id: String(sends.length) };
    },
    swap: async (_id: string, request: SwapRequest & { dry?: boolean }) => {
      if (request.dry) return { quote: quote(request) };
      sends.push("swap");
      balances[request.origin_asset]!.confidential -= BigInt(request.amount);
      balances[request.destination_asset]!.confidential += BigInt(quote(request).amount_out);
      afterSend();
      return { correlation_id: String(sends.length) };
    },
  }));
});
afterEach(() => mock.restoreAll());

const swap = (): PlannedAction => ({ type: "swap", from: input, to: output, amount: "5", amountOut: "5", minAmountOut: "5", costBps: 0 });
const execute = async (plan: Plan, autopilot = true) => {
  const events: PlanEvent[] = [];
  for await (const event of executePlan(plan.id, undefined, { autopilot })) events.push(event);
  return events;
};
const run = async (actions: PlannedAction[], autopilot = true) =>
  execute(savePlan((await observe()).snapshot, "rebalance", "offline valuation regression", actions), autopilot);

for (const asset of [input, output]) test(`expired ${asset === input ? "input" : "output"} price during dispatch preflight refuses before sending`, async () => {
  const fresh = prices;
  prices = () => fresh().map(token => priceReads >= 4 && token.asset_id === asset
    ? { ...token, price_updated_at: "2000-01-01T00:00:00Z", price_expires_at: "2000-01-02T00:00:00Z" } : token);
  const events = await run([swap()]);
  assert.deepEqual(sends, []);
  assert.equal(events.at(-1)?.type, "rejected");
  assert.equal(readOps()[0]?.refused, "valuation_unavailable");
});

test("a later swap cannot take submission-time run value above the autopilot ceiling", async () => {
  afterSend = () => { price = 1.01; };
  const events = await run([swap(), swap()]);
  assert.deepEqual(sends, ["swap"]);
  assert.equal(events.at(-1)?.type, "rejected");
  assert.deepEqual(readOps().map(op => ({ usd: op.usdIn, refusal: op.refused ?? null })), [
    { usd: 5, refusal: null }, { usd: 5.05, refusal: "autopilot_limit_exceeded" },
  ]);
});

test("at market prices and real decimals, the autopilot ceiling counts each swap's fractional USD value", async () => {
  // 5 USDC at $0.9997 is $4.9985: two fit under the $10 ceiling with a fraction to spare, a third does not.
  prices = () => timedPrices(marketTokens());
  quote = request => quoteAt(prices(), request);
  for (const token of marketTokens()) balances[token.asset_id] = { public: 0n, confidential: 20n * 10n ** BigInt(token.decimals) };
  const amount = "5000000", { amount_out } = quote({ origin_asset: input, destination_asset: output, amount });
  const leg: PlannedAction = { type: "swap", from: input, to: output, amount, amountOut: amount_out, minAmountOut: amount_out, costBps: 0 };
  const events = await run([leg, leg, leg]);
  assert.deepEqual(sends, ["swap", "swap"]);
  assert.equal(events.at(-1)?.type, "rejected");
  assert.deepEqual(readOps().map(op => ({ usd: op.usdIn, refusal: op.refused ?? null })), [
    { usd: 4.9985, refusal: null }, { usd: 4.9985, refusal: null }, { usd: 4.9985, refusal: "autopilot_limit_exceeded" },
  ]);
  // Each swap credits 5 × 0.9997 / 2.37 wNEAR, rounded down in raw units.
  assert.equal(balances[output]!.confidential, 20n * 10n ** 24n + 2n * 2_109071729957805907172995n);
});

test("automatic execution refuses decimal excess that floating addition rounds down to the ceiling", async () => {
  const strategy = loadStrategy();
  saveStrategy({ ...strategy, autopilot: { ...strategy.autopilot, maxUsd: 1 } });
  price = 0.9;
  afterSend = () => { price = 0.10000000000000005; };
  const leg = { ...swap(), amount: "1", amountOut: "1", minAmountOut: "1" };
  const events = await run([leg, leg]);
  assert.deepEqual(sends, ["swap"]);
  assert.equal(events.at(-1)?.type, "rejected");
  assert.equal(readOps().at(-1)?.refused, "autopilot_limit_exceeded");
});

test("cumulative authorization preserves every previously recorded decimal estimate", async () => {
  const strategy = loadStrategy();
  saveStrategy({ ...strategy, autopilot: { ...strategy.autopilot, maxUsd: 2 } });
  price = 0.9;
  afterSend = () => { price = sends.length === 1 ? 0.10000000000000005 : 1; };
  const leg = { ...swap(), amount: "1", amountOut: "1", minAmountOut: "1" };
  const events = await run([leg, leg, leg]);
  assert.deepEqual(sends, ["swap", "swap"]);
  assert.equal(events.at(-1)?.type, "rejected");
  assert.equal(readOps().at(-1)?.refused, "autopilot_limit_exceeded");
});

test("decimal equality stays executable at an integer strategy ceiling", async () => {
  const strategy = loadStrategy();
  saveStrategy({ ...strategy, autopilot: { ...strategy.autopilot, maxUsd: 1 } });
  price = 0.05;
  const leg = { ...swap(), amount: "1", amountOut: "1", minAmountOut: "1" };
  const events = await run(Array.from({ length: 20 }, () => ({ ...leg })));
  assert.deepEqual(sends, Array(20).fill("swap"));
  assert.equal(events.filter(event => event.type === "action" && event.status === "SUCCESS").length, 20);
});

for (const afterShield of [false, true]) test(`fractional ceiling excess ${afterShield ? "after" : "before"} a prerequisite shield refuses its swap`, async () => {
  const strategy = loadStrategy();
  saveStrategy({ ...strategy, autopilot: { ...strategy.autopilot, maxUsd: 1 } });
  balances[input] = { public: 2n, confidential: 0n };
  price = 0.9;
  afterSend = () => {
    if (sends.filter(method => method === "swap").length === 1)
      price = !afterShield || sends.at(-1) === "shield" ? 0.10000000000000005 : 0.1;
  };
  const leg = { ...swap(), amount: "1", amountOut: "1", minAmountOut: "1" };
  const events = await run([leg, leg]);
  assert.deepEqual(sends, afterShield ? ["shield", "swap", "shield"] : ["shield", "swap"]);
  assert.equal(events.at(-1)?.type, "rejected");
  assert.equal(readOps().at(-1)?.method, afterShield ? "swap" : "shield");
  assert.equal(readOps().at(-1)?.refused, "autopilot_limit_exceeded");
});

test("expired prices cannot produce a treasury plan", async () => {
  const fresh = prices;
  prices = () => fresh().map(token => ({ ...token, price_updated_at: "2000-01-01T00:00:00Z", price_expires_at: "2000-01-02T00:00:00Z" }));
  await assert.rejects(observe(), /fresh price/i);
  assert.deepEqual(sends, []);
});

test("an exact-ceiling run counts swaps once and leaves shields outside the ceiling", async () => {
  balances[input] = { public: 10n, confidential: 0n };
  const events = await run([swap(), swap()]);
  assert.deepEqual(sends, ["shield", "swap", "shield", "swap"]);
  assert.equal(events.filter(event => event.type === "action" && event.status === "SUCCESS").length, 2);
});

test("manual plan execution remains available above the automatic ceiling", async () => {
  afterSend = () => { price = 1.01; };
  const events = await run([swap(), swap()], false);
  assert.deepEqual(sends, ["swap", "swap"]);
  assert.equal(events.at(-1)?.type, "action");
});

for (const afterShield of [false, true]) test(`expired output price ${afterShield ? "after" : "before"} an automatic shield prevents its swap`, async () => {
  balances[input] = { public: 5n, confidential: 0n };
  const fresh = prices;
  prices = () => fresh().map(token => priceReads >= (afterShield ? 5 : 4) && token.asset_id === output
    ? { ...token, price_updated_at: "2000-01-01T00:00:00Z", price_expires_at: "2000-01-02T00:00:00Z" } : token);
  const events = await run([swap()]);
  assert.deepEqual(sends, afterShield ? ["shield"] : []);
  assert.equal(events.at(-1)?.type, "rejected");
  assert.equal(readOps().at(-1)?.refused, "valuation_unavailable");
});

test("an automatic swap above the remaining ceiling is refused before its prerequisite shield", async () => {
  balances[input] = { public: 10n, confidential: 0n };
  afterSend = () => { if (sends.at(-1) === "swap") price = 1.01; };
  const events = await run([swap(), swap()]);
  assert.deepEqual(sends, ["shield", "swap"]);
  assert.equal(events.at(-1)?.type, "rejected");
  assert.equal(readOps().at(-1)?.method, "shield");
  assert.equal(readOps().at(-1)?.refused, "autopilot_limit_exceeded");
});

test("dispatch values and authorizes against one clock observation after provider reads", async () => {
  const plan = savePlan((await observe()).snapshot, "rebalance", "one observation time", [swap()]);
  const observedAt = Date.now() + 100;
  let clockReads = 0;
  prices = () => timedPrices(Object.entries(ASSETS).map(([symbol, asset_id]) => ({ symbol, asset_id, decimals: 0, price: 1 })), observedAt);
  await withMoneyLock(lock => dispatch(lock, "rebalance", { method: "swap", request: {
    origin_asset: input, destination_asset: output, amount: "5", min_amount_out: "5", confidential: true,
  } }, { planned: { plan, leg: plan.actions[0]! }, autopilot: true, now: () => {
    clockReads++;
    return new Date(observedAt);
  } }));
  assert.equal(clockReads, 1);
  assert.deepEqual(sends, ["swap"]);
  assert.equal(readOps()[0]?.usdIn, 5, "journal valuation uses the authorization clock, not wall time");
});

type PriorState = "PREPARED" | "CLAIMED" | "LOCAL_REFUSED" | "REFUSED" | "SUCCESS" | "FAILED" | "REFUNDED";
function prior(key: string, usdIn: number | null | undefined, state: PriorState, { planId = "accounted", legacy = false, method = "swap" }: {
  planId?: string; legacy?: boolean; method?: Method;
} = {}) {
  const request = method === "swap" ? { origin_asset: input, destination_asset: output, amount: "5", confidential: true }
    : { asset: input, amount: "5" };
  record({ at: new Date().toISOString(), idempotencyKey: key, kind: "rebalance", request, planId,
    ...(legacy ? {} : { journalVersion: 2 as const, method }), ...(usdIn === undefined ? {} : { usdIn }) });
  if (state === "PREPARED") return;
  if (state === "LOCAL_REFUSED") { record({ idempotencyKey: key, refused: "valuation_unavailable" }); return; }
  if (!legacy) claimSubmission(key, request);
  if (state === "CLAIMED") return;
  if (state === "REFUSED") { record({ idempotencyKey: key, refused: "policy_denied" }); return; }
  record({ idempotencyKey: key, correlation_id: key, status: "SENT" });
  record({ idempotencyKey: key, correlation_id: key, status: state });
}

test("journal accounting counts submitted swaps once, retains failed/refunded value, and excludes non-submissions", () => {
  prior("success", 2, "SUCCESS");
  record({ idempotencyKey: "success", correlation_id: "success", status: "SUCCESS" });
  prior("failed", 3, "FAILED");
  prior("refunded", 4, "REFUNDED");
  prior("legacy", 1, "SUCCESS", { legacy: true });
  prior("local-refusal", null, "LOCAL_REFUSED");
  prior("provider-refusal", 99, "REFUSED");
  prior("preparation", 99, "PREPARED");
  prior("shield", 99, "SUCCESS", { method: "shield" });
  prior("other-plan", 99, "SUCCESS", { planId: "other" });
  assert.deepEqual(submittedSwapValues(readOps(), "accounted"), [2, 3, 4, 1]);
  assert.deepEqual(submittedSwapValues(readOps(), "accounted"), [2, 3, 4, 1], "rereading durable evidence never resets or duplicates its value");
  assert.equal(withinRunCeiling(submittedSwapValues(readOps(), "accounted"), 10), true);
});

for (const value of [undefined, null, -1]) test(`a submitted legacy swap with ${String(value)} valuation leaves cumulative value unknown`, () => {
  prior("legacy", value, "SUCCESS", { legacy: true });
  assert.equal(withinRunCeiling(submittedSwapValues(readOps(), "accounted"), 10), null);
});

test("finite journal values exceeding Number capacity are still provably above the ceiling", () => {
  prior("first", 1e308, "SUCCESS");
  prior("second", 1e308, "SUCCESS");
  assert.deepEqual(submittedSwapValues(readOps(), "accounted"), [1e308, 1e308]);
  assert.equal(withinRunCeiling(submittedSwapValues(readOps(), "accounted"), Number.MAX_VALUE), false);
});

test("unknown historical plan valuation refuses automatic continuation instead of implying unused capacity", async () => {
  const plan = savePlan((await observe()).snapshot, "rebalance", "missing historical valuation", [swap()]);
  prior("legacy", undefined, "SUCCESS", { legacy: true, planId: plan.id });
  const events = await execute(plan);
  assert.deepEqual(sends, []);
  assert.equal(events.at(-1)?.type, "rejected");
  assert.equal(readOps().at(-1)?.refused, "valuation_unavailable");
});

test("an unresolved submission blocks new execution regardless of cumulative valuation", async () => {
  prior("unknown", 1, "CLAIMED");
  assert.deepEqual(submittedSwapValues(readOps(), "accounted"), [1]);
  await assert.rejects(run([swap()]), /earlier money action/);
  assert.deepEqual(sends, []);
  assert.equal(readOps()[0]?.submissionState, "SUBMISSION_ATTEMPTED");
  assert.equal(readOps()[0]?.refused, undefined);
});

test("a plan refused for valuation stays claimed after prices recover and is never resubmitted", async () => {
  const plan = savePlan((await observe()).snapshot, "rebalance", "claim survives refusal", [swap()]);
  const fresh = prices;
  prices = () => fresh().map(token => priceReads >= 4
    ? { ...token, price_updated_at: "2000-01-01T00:00:00Z", price_expires_at: "2000-01-02T00:00:00Z" } : token);
  assert.equal((await execute(plan)).at(-1)?.type, "rejected");
  prices = fresh;
  assert.deepEqual(await execute(plan), [{ type: "rejected", problems: ["the plan was already executed"] }]);
  assert.deepEqual(sends, []);
  assert.equal(readOps().length, 1);
});

test("a send refused for a code outside the plan's own reaches the owner as refused with its code, not unknown", async () => {
  const plan = savePlan((await observe()).snapshot, "rebalance", "grant ended before the send", [swap()]);
  mock.method(api, "listGrants", async () => []);
  const stream = await createRouterClient(router).executePlan({ planId: plan.id });
  await assert.rejects(async () => { for await (const _ of stream) { /* drain */ } },
    (error: unknown) => { assert.ok(error instanceof ORPCError); assert.deepEqual([error.code, error.data], ["BAD_REQUEST", { kind: "refused", code: "grant_missing" }]); return true; });
  assert.deepEqual(sends, []);
  assert.equal(readOps()[0]?.refused, "grant_missing");
});

for (const [refusal, code, reason, refuse] of [
  ["the grant ending", "grant_missing", "grant_missing: No live grant is held for this agent", () => mock.method(api, "listGrants", async () => [])],
  // The provider's own title and detail never reach the owner.
  ["the provider", "policy_denied", "policy_denied: the swap was refused before it was sent", () => mock.method(api, "forGrant", () => ({ swap: async () => {
    throw new AgentApiError(403, { errors: [{ status: "403", code: "policy_denied", title: "provider-title", detail: "provider-detail" }] } as never); } }))],
] as const) test(`a swap refused by ${refusal} after its shield was sent ends the leg with both, not a refused call`, async () => {
  balances[input] = { public: 5n, confidential: 0n };
  const plan = savePlan((await observe()).snapshot, "rebalance", "shield, then a refused swap", [swap()]);
  const { shield, swap: quote } = (api.forGrant as unknown as () => { shield: (...args: never[]) => Promise<unknown>; swap: (...args: never[]) => Promise<unknown> })();
  mock.method(api, "forGrant", () => ({ swap: quote, shield: async (...args: never[]) => { const sent = await shield(...args); refuse(); return sent; } }));
  const events: PlanEvent[] = [];
  for await (const event of await createRouterClient(router).executePlan({ planId: plan.id })) events.push(event as PlanEvent);
  assert.deepEqual(events.map(e => e.type === "action" ? [e.status, e.shield, e.failureCode] : e.problems),
    [["NOT_SENT", { amount: "5", status: "SUCCESS" }, code], [reason]]);
  assert.deepEqual(sends, ["shield"]);
  assert.deepEqual(readOps().map(op => [op.method, op.status ?? null, op.refused ?? null]), [["shield", "SUCCESS", null], ["swap", null, code]]);
});
