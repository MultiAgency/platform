import type { Policy } from "@near-intents-agent-api/sdk";
import { mayBuy } from "../policy.js";
import { caused, type Caused } from "./causes.js";
import type { Plan, PlannedAction, Snapshot } from "./model.js";

type Live = Snapshot & { now: Date; quotes: string[]; assets: Policy["assets"] };

/**
 * Why a plan can no longer execute as previewed; empty when it still can. `quotes` holds a fresh
 * `amount_out` for each swap action, in order; `assets` is the live policy's.
 */
export const checkPlan = (plan: Plan, live: Live): string[] => checkPlanCaused(plan, live).map(problem => problem.text);

/** `checkPlan`, each problem with its cause (`causes.ts`). */
export function checkPlanCaused(plan: Plan, live: Live): Caused[] {
  const problems: Caused[] = [];
  if (!Number.isFinite(Date.parse(plan.expiresAt)) || live.now >= new Date(plan.expiresAt)) problems.push(caused("plan_expired", `the plan expired at ${plan.expiresAt}`));
  if (live.agentId !== plan.agentId) problems.push(caused("invalid_plan", "the plan is for another agent"));
  if (live.policyRevision !== plan.policyRevision || live.policyDigest !== plan.policyDigest)
    problems.push(caused("policy_changed",
      `the policy changed (revision ${plan.policyRevision} → ${live.policyRevision}, ${plan.policyDigest} → ${live.policyDigest})`));
  if (live.strategyDigest !== plan.strategyDigest)
    problems.push(caused("strategy_changed", `the owner's strategy changed (${plan.strategyDigest} → ${live.strategyDigest})`));
  // Funds arriving change nothing the plan relies on; less of what it spends means something else
  // spent it, and the plan's amounts no longer describe the book.
  const spent = new Set(plan.actions.map((a) => (a.type === "swap" ? a.from : a.asset)));
  for (const asset of spent) {
    const was = plan.balances[asset];
    const now = live.balances[asset];
    if (!was) continue;
    if (BigInt(now?.public ?? 0) < BigInt(was.public) || BigInt(now?.confidential ?? 0) < BigInt(was.confidential))
      problems.push(caused("balance", `the ${asset} balance fell since the preview`));
  }
  const swaps = plan.actions.filter((a) => a.type === "swap");
  swaps.forEach((swap, i) => {
    if (!mayBuy(live.assets, swap.to)) problems.push(caused("outside_policy_assets", `swap ${i + 1} buys ${swap.to}, outside the policy's assets`));
    const quoted = live.quotes[i];
    if (quoted === undefined) problems.push(caused("provider_warning", `no fresh quote for swap ${i + 1}`));
    else if (BigInt(quoted) < BigInt(swap.minAmountOut))
      problems.push(caused("floor", `swap ${i + 1} now quotes ${quoted}, below its previewed floor ${swap.minAmountOut}`));
  });
  return problems;
}

class Infeasible extends Error { constructor(readonly cause: "invalid_plan" | "balance", message: string) { super(message); } }

/** Simulate each spend once; future swaps contribute only their guaranteed output floor. */
export const feasibility = (actions: PlannedAction[], balances: Snapshot["balances"]): string[] =>
  feasibilityCaused(actions, balances).map(problem => problem.text);

/** `feasibility`, each problem with its cause: a spend over the balance is `balance`, a malformed action `invalid_plan`. */
export function feasibilityCaused(actions: PlannedAction[], balances: Snapshot["balances"]): Caused[] {
  const book = new Map(Object.entries(balances).map(([asset, b]) =>
    [asset, { public: BigInt(b.public), confidential: BigInt(b.confidential) }]));
  try {
    for (const [i, action] of actions.entries()) {
      if (!/^[0-9]+$/.test(action.amount) || BigInt(action.amount) <= 0n) throw new Infeasible("invalid_plan", "invalid amount");
      const amount = BigInt(action.amount);
      const from = book.get(action.type === "shield" ? action.asset : action.from);
      if (!from) throw new Infeasible("invalid_plan", "unknown input asset");
      if (action.type === "shield") {
        if (from.public < amount) throw new Infeasible("balance", `action ${i + 1} exceeds remaining public balance`);
        from.public -= amount; from.confidential += amount;
      } else {
        const to = book.get(action.to);
        if (!to || action.from === action.to) throw new Infeasible("invalid_plan", "invalid output asset");
        if (!/^[0-9]+$/.test(action.minAmountOut) || BigInt(action.minAmountOut) <= 0n)
          throw new Infeasible("invalid_plan", "invalid output floor");
        if (from.public + from.confidential < amount)
          throw new Infeasible("balance", `action ${i + 1} exceeds remaining balance`);
        const shield = amount > from.confidential ? amount - from.confidential : 0n;
        from.public -= shield; from.confidential += shield - amount;
        to.confidential += BigInt(action.minAmountOut);
      }
    }
    return [];
  } catch (error) { return [caused(error instanceof Infeasible ? error.cause : "invalid_plan", `plan infeasible: ${(error as Error).message}`)]; }
}
