import { dispatch, LocalRefusal, type Sending } from "../agent.js";
import type { Holding } from "../holdings.js";
import { acquireMoneyLock } from "../lock.js";
import { usdValue } from "../value.js";
import { blockingWarnings, executeLeg, quoteLeg, warnedReason } from "../treasury.js";
import type { PlannedAction } from "./model.js";
import { loadPlan, claimPlan } from "./store.js";
import { observe } from "./observation.js";
import { checkPlan, feasibility } from "./checks.js";

export type PlanEvent =
  | { type: "rejected"; problems: string[] }
  | {
      type: "action";
      index: number;
      action: PlannedAction;
      /** The shield a swap needed first, when part of its input was public. */
      shield?: { amount: string; status: string };
      /** `NOT_SENT` when the shield before it did not succeed. */
      status: string;
      correlationId: string;
      failureCode: string | null | undefined;
    };

const PLAN_REFUSALS = new Set(["plan_expired", "plan_agent_changed", "strategy_changed", "plan_policy_changed", "swap_cost_exceeded", "valuation_unavailable", "autopilot_limit_exceeded"]);

const legFor = (book: Holding[], action: Extract<PlannedAction, { type: "swap" }>) => {
  const from = book.find((h) => h.asset === action.from)!;
  const to = book.find((h) => h.asset === action.to)!;
  const amount = BigInt(action.amount);
  return { from, to, amount, usd: usdValue(amount, from.decimals, from.price) };
};

/** Executes a saved plan exactly as previewed, under the money lock, or says why it can't. */
export async function* executePlan(id: string, now = () => new Date(), { autopilot = false, onSubmitted }: { autopilot?: boolean; onSubmitted?: Sending["onSubmitted"] } = {}): AsyncGenerator<PlanEvent> {
  const plan = loadPlan(id);
  const lock = await acquireMoneyLock();
  try {
    // Fresh state, read under the lock so nothing else can move it before we act.
    const { snapshot: live, book, assets } = await observe();
    const invalid = feasibility(plan.actions, live.balances);
    if (invalid.length) { yield { type: "rejected", problems: invalid }; return; }
    // Fresh quotes, under the lock: a leg the provider now warns about is rejected before the plan is claimed.
    const quotes: string[] = [], warned: string[] = [];
    for (const action of plan.actions)
      if (action.type === "swap") { const quote = await quoteLeg(legFor(book, action)); quotes.push(quote.amountOut); warned.push(...blockingWarnings(quote)); }
    if (warned.length) { yield { type: "rejected", problems: [warnedReason(warned)] }; return; }
    const problems = checkPlan(plan, { ...live, now: now(), quotes, assets });
    if (problems.length > 0) {
      yield { type: "rejected", problems };
      return;
    }

    // Claimed before the first action: a plan runs at most once, even if it stops partway.
    if (!claimPlan(id)) {
      yield { type: "rejected", problems: ["the plan was already executed"] };
      return;
    }

    const sending = (leg: PlannedAction): Sending => ({ planned: { plan, leg }, autopilot, now, onSubmitted });
    for (const [index, action] of plan.actions.entries()) {
      const current = await observe();
      const problems = feasibility(plan.actions.slice(index), current.snapshot.balances);
      // The initial preview-balance check is replaced with remaining-plan feasibility after each leg.
      problems.push(...checkPlan({ ...plan, balances: current.snapshot.balances, actions: [] },
        { ...current.snapshot, now: now(), quotes: [], assets: current.assets }));
      if (problems.length) { yield { type: "rejected", problems }; return; }
      if (action.type === "shield") {
        const request = { asset: action.asset, amount: action.amount };
        const settled = await dispatch(lock, plan.source, { method: "shield", request }, sending(action));
        yield { type: "action", index, action, status: settled.status, correlationId: settled.correlation_id, failureCode: settled.failure_code };
        if (settled.status !== "SUCCESS") return;
        continue;
      }
      const { shortfall, shielded, swapped } = await executeLeg(lock, legFor(current.book, action), action.minAmountOut, plan.source, sending(action));
      const shield = shielded && { amount: shortfall.toString(), status: shielded.status };
      if (!swapped) {
        yield { type: "action", index, action, shield, status: "NOT_SENT", correlationId: "", failureCode: null };
        return;
      }
      yield { type: "action", index, action, shield, status: swapped.status, correlationId: swapped.correlation_id, failureCode: swapped.failure_code };
      // Anything short of SUCCESS changes the book the rest of the plan assumed: stop.
      if (swapped.status !== "SUCCESS") return;
    }
  } catch (error) {
    // `authorize` refuses a send whose plan no longer holds; the refusal is logged and the plan stops.
    if (!(error instanceof LocalRefusal && PLAN_REFUSALS.has(error.code))) throw error;
    yield { type: "rejected", problems: [error.message] };
  } finally {
    await lock.release();
  }
}
