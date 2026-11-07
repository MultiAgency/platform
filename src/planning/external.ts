import { z } from "zod";
import { ASSETS, mayBuy } from "../policy.js";
import { PublicError } from "../public-error.js";
import { loadStrategy } from "../strategy.js";
import { strategyDigest } from "../strategy-digest.js";
import { blockingWarnings, quoteLeg, warnedReason, type Leg } from "../treasury.js";
import { usdValue } from "../value.js";
import { checkPlan, feasibility } from "./checks.js";
import type { Plan, PlannedAction } from "./model.js";
import { observe } from "./observation.js";
import { savePlan } from "./store.js";

const Asset = z.enum(Object.values(ASSETS) as [string, ...string[]]);
const Amount = z.string().regex(/^[0-9]{1,40}$/).refine(value => BigInt(value) > 0n, "Amount must be positive");
export const ExternalPlanInput = z.strictObject({
  swaps: z.array(z.strictObject({ from: Asset, to: Asset, amount: Amount, minAmountOut: Amount.optional() })
    .refine(swap => swap.from !== swap.to, "Swap assets must differ")).min(1).max(8),
});

/** A chosen swap as `quoteChosen` takes it: raw units, an optional floor the chooser requires. */
export type ChosenSwap = { from: string; to: string; amount: string; minAmountOut?: string };

/**
 * Quotes chosen swaps and checks everything a saved plan must hold (output asset, valuation, no blocking provider
 * warning, a floor at or above the quote's and at most its output, cost within the strategy, feasibility now and against
 * a second observation, unchanged policy and strategy), saving nothing and sending nothing. A swap it won't plan is a
 * `PublicError`; a provider failure keeps its own class.
 */
export async function quoteChosen(swaps: ChosenSwap[]) {
  const { snapshot, book, assets } = await observe();
  const strategy = loadStrategy();
  if (strategyDigest(strategy) !== snapshot.strategyDigest) throw new PublicError("Owner strategy changed during observation");
  const actions: Extract<PlannedAction, { type: "swap" }>[] = [], usdIn: number[] = [];
  for (const swap of swaps) {
    if (!mayBuy(assets, swap.to)) throw new PublicError("Swap output is outside the policy's assets");
    const from = book.find(h => h.asset === swap.from)!;
    const to = book.find(h => h.asset === swap.to)!;
    const amount = BigInt(swap.amount);
    const usd = usdValue(amount, from.decimals, from.price);
    if (!Number.isFinite(usd) || usd <= 0) throw new PublicError("Swap has no finite positive valuation");
    const leg: Leg = { from, to, amount, usd };
    const quote = await quoteLeg(leg);
    const warned = blockingWarnings(quote);
    if (warned.length) throw new PublicError(`Not planned: ${warnedReason(warned)}`);
    if (!Amount.safeParse(quote.amountOut).success || !Amount.safeParse(quote.minAmountOut).success || BigInt(quote.minAmountOut) > BigInt(quote.amountOut))
      throw new Error("Quote has invalid output amounts");
    const floor = swap.minAmountOut && BigInt(swap.minAmountOut) > BigInt(quote.minAmountOut) ? swap.minAmountOut : quote.minAmountOut;
    const named = `swap ${swap.amount} ${swap.from} for ${swap.to}`;
    if (BigInt(floor) > BigInt(quote.amountOut))
      throw new PublicError(`Requested output floor ${floor} exceeds the quoted output ${quote.amountOut} (${named})`);
    if (!Number.isFinite(quote.worstCostBps) || quote.worstCostBps > strategy.maxCostBps)
      throw new PublicError(`Quote's worst-case cost ${quote.worstCostBps} bps exceeds the owner's cost limit ${strategy.maxCostBps} bps (${named})`);
    actions.push({ type: "swap", from: swap.from, to: swap.to, amount: swap.amount,
      amountOut: quote.amountOut, minAmountOut: floor, costBps: quote.costBps });
    usdIn.push(usd);
  }
  const live = await observe();
  const now = new Date();
  const draft: Plan = { ...snapshot, id: "", source: "external", instruction: "",
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 300_000).toISOString(), actions };
  const problems = [...feasibility(actions, snapshot.balances), ...feasibility(actions, live.snapshot.balances),
    ...checkPlan(draft, { ...live.snapshot, now, assets: live.assets,
      quotes: actions.map(action => action.amountOut) })];
  if (problems.length) throw new PublicError(problems.join("; "));
  return { snapshot, actions, usdIn, now };
}

/** External intelligence chooses swaps; Treasury supplies quotes and all execution constraints. Never sends. */
export async function prepareExternalPlan(input: unknown): Promise<Plan> {
  const { swaps } = ExternalPlanInput.parse(input);
  const { snapshot, actions, now } = await quoteChosen(swaps);
  return savePlan(snapshot, "external", "External agent's chosen swaps", actions, now);
}
