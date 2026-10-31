import type { StatusResponse } from "@near-intents-agent-api/sdk";
import { agent, dispatch, type Sending } from "./agent.js";
import { agentId } from "./env.js";
import { budgetRemaining, type Holding, holdings } from "./holdings.js";
import { acquireMoneyLock, type MoneyLock } from "./lock.js";
import { observe } from "./planning/observation.js";
import { savePlan } from "./planning/store.js";
import type { Plan, PlannedAction } from "./planning/model.js";
import { loadStrategy } from "./strategy.js";
import type { Strategy } from "./strategy-digest.js";
import { costBps, usdValue } from "./value.js";

/**
 * The agent's strategies as event streams: each yields what it sees and does, so the CLIs and
 * the dashboard render one code path. A rebalance only previews: it saves a plan that
 * `executePlan` runs exactly as previewed.
 */

/** The strategy's target share of the book per asset, as fractions. */
export const targets = (strategy: Strategy): Record<string, number> =>
  Object.fromEntries(Object.entries(strategy.targetBps).map(([asset, bps]) => [asset, bps / 10_000]));
export type Leg = { from: Holding; to: Holding; usd: number; amount: bigint };

/**
 * A dry quote: `costBps` is what the swap is expected to lose to fees and price impact; `worstCostBps`
 * what it loses if it returns only its guaranteed floor. The strategy's cost cap applies to the worst case.
 */
/** A leg's dry-run quote; `warnings` are the codes of the provider's warnings on it (their detail text is dropped). */
type Quote = { amountOut: string; minAmountOut: string; costBps: number; worstCostBps: number; warnings: string[] };

/**
 * Provider warnings a leg may carry and still be planned and sent: none for now. Per the provider's docs a dry run warns
 * with the live refusal codes (`policy_*`, `spend_*`, `insufficient_balance`): the live swap will be refused with that
 * code, and several of those codes aren't proven refusals here (`ops.ts`), so sending one would leave the agent blocked on
 * an unresolved operation. Those may never be allowed. Informational warnings (`high_fee`, `asset_delivered_as_is`) are
 * refused too until there is evidence for allowing each (user's decision, 2026-10-30).
 */
const ALLOWED_WARNINGS = new Set<string>();
/** The codes on a quote that keep its leg out of any plan and away from the send site. */
export const blockingWarnings = (quote: Quote) => quote.warnings.filter((code) => !ALLOWED_WARNINGS.has(code));
/** Why a leg with these codes isn't planned or sent: what the owner (or the app) reads. */
export const warnedCodes = (codes: string[]) => [...new Set(codes)].sort().join(", ");
export const warnedReason = (codes: string[]) => `the provider's dry run warned (${warnedCodes(codes)}), so the swap was not sent`;

type RebalanceEvent =
  | { type: "plan"; total: number; book: Holding[]; legs: Leg[]; budget: string | null | undefined; strategy: Strategy }
  | ({ type: "quote"; leg: number; skipped: boolean } & Quote)
  /** `steps[i]` is leg i's step in the plan, absent when the leg was skipped. */
  | { type: "saved"; plan: Plan; steps: (number | undefined)[] };

/** Greedy plan toward the strategy's targets: move value from the most over-weight asset to the most under-weight one. */
export function planLegs(book: Holding[], strategy: Strategy) {
  const total = book.reduce((sum, h) => sum + h.usd, 0);
  const share = targets(strategy);
  const drift = new Map(book.map((h) => [h.asset, h.usd - total * (share[h.asset] ?? 0)]));
  const legs: Leg[] = [];
  while (true) {
    const sorted = [...drift.entries()].sort((a, b) => b[1] - a[1]);
    const [fromAsset, surplus] = sorted[0]!;
    const [toAsset, deficit] = sorted[sorted.length - 1]!;
    const usd = Math.min(surplus, -deficit);
    if (usd < strategy.minLegUsd) break;
    const from = book.find((h) => h.asset === fromAsset)!;
    const to = book.find((h) => h.asset === toAsset)!;
    // A share of the actual balance, so rounding can never ask for more than the account holds.
    const held = from.public + from.confidential;
    const amount = (held * BigInt(Math.floor((usd / from.usd) * 1e9))) / 1_000_000_000n;
    legs.push({ from, to, usd, amount });
    drift.set(fromAsset, surplus - usd);
    drift.set(toAsset, deficit + usd);
  }
  return { total, legs };
}

/** Plans and quotes every leg, and saves the legs worth their cost as a plan. Nothing moves. */
export async function* rebalance(): AsyncGenerator<RebalanceEvent> {
  const strategy = loadStrategy();
  const { snapshot, book } = await observe();
  const { total, legs } = planLegs(book, strategy);
  yield { type: "plan", total, book, legs, budget: await budgetRemaining(), strategy };

  const quotes: Quote[] = [];
  for (const [i, leg] of legs.entries()) {
    const quote = await quoteLeg(leg);
    quotes.push(quote);
    yield { type: "quote", leg: i, ...quote, skipped: quote.worstCostBps > strategy.maxCostBps || blockingWarnings(quote).length > 0 };
  }
  const { actions, steps } = planSteps(legs, quotes, strategy.maxCostBps);
  if (actions.length > 0) yield { type: "saved", plan: savePlan(snapshot, "rebalance", "Rebalance toward the target split", actions), steps };
}

/**
 * Each leg costing at most `maxCostBps`, and carrying no blocking provider warning, as a plan step, held to its quoted
 * floor; `steps[i]` maps leg i to its step.
 */
export function planSteps(legs: Leg[], quotes: Quote[], maxCostBps: number) {
  const actions: PlannedAction[] = [];
  const steps = legs.map((leg, i) => {
    const quote = quotes[i]!, { amountOut, minAmountOut, costBps, worstCostBps } = quote;
    if (worstCostBps > maxCostBps || blockingWarnings(quote).length > 0) return undefined;
    actions.push({ type: "swap", from: leg.from.asset, to: leg.to.asset, amount: leg.amount.toString(), amountOut, minAmountOut, costBps });
    return actions.length - 1;
  });
  return { actions, steps };
}

/** Every swap is confidential: it spends and credits the confidential balance, off the public chain. */
const swapRequest = (leg: Leg) => ({
  origin_asset: leg.from.asset,
  destination_asset: leg.to.asset,
  amount: leg.amount.toString(),
  confidential: true,
});

/** A dry quote for one leg, with what it would lose to fees and price impact, expected and at worst. */
export async function quoteLeg(leg: Leg): Promise<Quote> {
  const { quote, warnings } = await agent().swap(agentId(), { ...swapRequest(leg), dry: true });
  const amountOut = typeof quote.amount_out === "string" ? quote.amount_out : undefined;
  const minAmountOut = typeof quote.min_amount_out === "string" ? quote.min_amount_out : undefined;
  if (!amountOut || !minAmountOut) throw new Error("quote has no amount_out/min_amount_out");
  return quoteOf(leg, amountOut, minAmountOut, (warnings ?? []).map((warning) => warning.code));
}

/**
 * A leg's quote, with what it loses to fees and price impact in whole basis points. The worst case
 * rounds up, since `authorize` compares it unrounded against the whole-bps cap: a leg over the cap by
 * a fraction of a bps is left out of the plan, not refused after the plan is claimed.
 */
export function quoteOf(leg: Leg, amountOut: string, minAmountOut: string, warnings: string[] = []): Quote {
  const cost = (raw: string) => costBps(leg.usd, usdValue(raw, leg.to.decimals, leg.to.price));
  return { amountOut, minAmountOut, costBps: Math.round(cost(amountOut)), worstCostBps: Math.ceil(cost(minAmountOut)), warnings };
}

/**
 * Executes one quoted leg. Swaps spend the confidential balance, so any part still public is
 * shielded first; `swapped` is absent when that shield did not succeed.
 */
export async function executeLeg(lock: MoneyLock, leg: Leg, minAmountOut: string, kind: string, sending?: Sending) {
  const shortfall = leg.amount - leg.from.confidential;
  let shielded: StatusResponse | undefined;
  if (shortfall > 0n) {
    const request = { asset: leg.from.asset, amount: shortfall.toString() };
    shielded = await dispatch(lock, "shield", { method: "shield", request }, sending);
    if (shielded.status !== "SUCCESS") return { shortfall, shielded };
  }
  const request = { ...swapRequest(leg), min_amount_out: minAmountOut };
  const swapped = await dispatch(lock, kind, { method: "swap", request }, sending);
  return { shortfall, shielded, swapped };
}

type SweepEvent =
  | { type: "plan"; exposed: Holding[] }
  | { type: "shield"; asset: string; status: string; correlationId: string; failureCode: string | null | undefined };

/** `autopilot`: the autopilot sweeps, so each shield is authorized as the autopilot's, under the strategy the owner's grant approves. */
export async function* sweep({ execute, autopilot = false, onSubmitted }: { execute: boolean; autopilot?: boolean; onSubmitted?: Sending["onSubmitted"] }): AsyncGenerator<SweepEvent> {
  const lock = execute ? await acquireMoneyLock() : undefined;
  try {
    yield* sweepRun(lock, autopilot ? { planned: null, autopilot: true, now: () => new Date(), onSubmitted } : undefined);
  } finally {
    await lock?.release();
  }
}

/**
 * Shields every public balance. The agent keeps nothing public, since its account is linked to its
 * owner on chain; a public balance appears only when funds arrive outside a confidential deposit.
 */
async function* sweepRun(lock: MoneyLock | undefined, sending: Sending | undefined): AsyncGenerator<SweepEvent> {
  const exposed = (await holdings()).filter((h) => h.public > 0n);
  yield { type: "plan", exposed };
  if (!lock) return;

  for (const h of exposed) {
    const settled = await dispatch(lock, "sweep", { method: "shield", request: { asset: h.asset, amount: h.public.toString() } }, sending);
    yield {
      type: "shield",
      asset: h.asset,
      status: settled.status,
      correlationId: settled.correlation_id,
      failureCode: settled.failure_code,
    };
    if (settled.status !== "SUCCESS") return;
  }
}
