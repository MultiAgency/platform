import assert from "node:assert/strict";
import { test } from "node:test";
import type { Holding } from "../src/holdings.js";
import { DEFAULT_STRATEGY } from "../src/strategy-digest.js";
import { ASSETS } from "../src/policy.js";
import { type Leg, planLegs, planSteps, quoteOf } from "../src/treasury.js";
import { costBps, usdValue } from "../src/value.js";

const MAX_COST_BPS = DEFAULT_STRATEGY.maxCostBps;

const holding = (asset: string) => ({ asset }) as Holding;
const leg = (from: string, to: string, amount: bigint): Leg => ({ from: holding(from), to: holding(to), usd: 3, amount });
/** A quote expected to cost `costBps`, and `worstCostBps` if it only returns its guaranteed floor. */
const quote = (costBps: number, worstCostBps = costBps, warnings: string[] = []) => ({ amountOut: "561", minAmountOut: "555", costBps, worstCostBps, warnings });

test("each leg worth its cost becomes a swap held to its quoted floor", () => {
  const { actions, steps } = planSteps([leg("usdc", "wnear", 3_000_000n)], [quote(44)], MAX_COST_BPS);
  assert.deepEqual(actions, [
    { type: "swap", from: "usdc", to: "wnear", amount: "3000000", amountOut: "561", minAmountOut: "555", costBps: 44 },
  ]);
  assert.deepEqual(steps, [0]);
});

test("a leg costing more than it is worth is left out, and later steps keep their legs", () => {
  const legs = [leg("usdc", "wnear", 1n), leg("usdc", "eth", 2n), leg("eth", "wnear", 3n)];
  const { actions, steps } = planSteps(legs, [quote(MAX_COST_BPS + 1), quote(MAX_COST_BPS), quote(10)], MAX_COST_BPS);
  assert.deepEqual(
    actions.map((a) => a.type === "swap" && a.amount),
    ["2", "3"],
  );
  assert.deepEqual(steps, [undefined, 0, 1]);
});

test("a leg is planned only if authorize would send it at the same prices: its worst cost rounds up", () => {
  // $10,000 in for a floor worth $9,749.60: 250.4 bps at worst, over a 250 bps cap.
  const from = { asset: "usdc", decimals: 0, price: 1 } as Holding;
  const to = { asset: "wnear", decimals: 1, price: 1 } as Holding;
  const swap: Leg = { from, to, usd: 10_000, amount: 10_000n };
  const quoted = quoteOf(swap, "97600", "97496");
  // authorize's own reckoning of the same leg (src/authorize.ts, swap_cost_exceeded).
  assert.ok(costBps(usdValue(swap.amount, from.decimals, from.price), usdValue(quoted.minAmountOut, to.decimals, to.price)) > 250);
  assert.equal(quoted.worstCostBps, 251);
  assert.deepEqual(planSteps([swap], [quoted], 250).actions, []);
});

test("the cost cap holds at the swap's guaranteed floor, not only at its expected price", () => {
  // Expected to cost 94 bps, but the floor the API guarantees is ~1% lower: 194 bps in the worst case.
  const { actions, steps } = planSteps([leg("wnear", "usdc", 1n)], [quote(94, 194)], 150);
  assert.deepEqual(actions, []);
  assert.deepEqual(steps, [undefined]);
  assert.equal(planSteps([leg("wnear", "usdc", 1n)], [quote(94, 194)], 250).actions.length, 1);
});

test("the owner's strategy decides the legs: its targets, and the smallest leg worth a fee", () => {
  const held = (asset: string, usd: number) => ({ asset, usd, public: 0n, confidential: 1_000_000n }) as Holding;
  // $20 USDC, $10 wNEAR, $10 ETH: on target for the default 50/25/25.
  const book = [held(ASSETS.USDC, 20), held(ASSETS.wNEAR, 10), held(ASSETS.ETH, 10)];
  assert.deepEqual(planLegs(book, DEFAULT_STRATEGY).legs, []);

  const stable = { ...DEFAULT_STRATEGY, targetBps: { [ASSETS.USDC]: 7_000, [ASSETS.wNEAR]: 1_500, [ASSETS.ETH]: 1_500 } };
  const legs = planLegs(book, stable).legs.map((l) => [l.from.asset, l.to.asset, Math.round(l.usd)]);
  assert.deepEqual(legs, [
    [ASSETS.wNEAR, ASSETS.USDC, 4],
    [ASSETS.ETH, ASSETS.USDC, 4],
  ]);
  // The same drift, but each leg is now under the owner's minimum: left alone.
  assert.deepEqual(planLegs(book, { ...stable, minLegUsd: 5 }).legs, []);
});

test("a leg the provider warns about is left out of the plan, however cheap", () => {
  const { actions, steps } = planSteps([leg("usdc", "wnear", 3_000_000n), leg("usdc", "eth", 1_000_000n)],
    [quote(10, 10, ["high_fee"]), quote(10)], MAX_COST_BPS);
  assert.deepEqual(steps, [undefined, 0], "an informational warning is refused too, until allowed on evidence");
  assert.equal(actions.length, 1);
});
