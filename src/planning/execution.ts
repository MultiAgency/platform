import { dispatch, LocalRefusal, type Sending } from "../agent.js";
import type { Holding } from "../holdings.js";
import { acquireMoneyLock, assertNotStopping, Stopping } from "../lock.js";
import { usdValue } from "../value.js";
import { blockingWarnings, executeLeg, quoteLeg, warnedReason } from "../treasury.js";
import type { Plan, PlannedAction } from "./model.js";
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
      /** `NOT_SENT` when the shield before it did not succeed, or the swap was proven not sent after it (`failureCode`: why). */
      status: string;
      correlationId: string;
      failureCode: string | null | undefined;
    };

const PLAN_REFUSALS = new Set(["plan_expired", "plan_agent_changed", "strategy_changed", "plan_policy_changed", "swap_cost_exceeded", "valuation_unavailable", "autopilot_limit_exceeded", "cash_floor_exceeded"]);

const legFor = (book: Holding[], action: Extract<PlannedAction, { type: "swap" }>) => {
  const from = book.find((h) => h.asset === action.from)!;
  const to = book.find((h) => h.asset === action.to)!;
  const amount = BigInt(action.amount);
  return { from, to, amount, usd: usdValue(amount, from.decimals, from.price) };
};

/** The state read under the lock that a pre-claim check may judge. */
export type Observed = Awaited<ReturnType<typeof observe>>;
/**
 * `beforeClaim`: a caller's own checks, run under the money lock after every check of the plan and immediately before
 * its claim; any problem rejects the plan with nothing claimed or sent. `proposal`: the proposal this plan executes;
 * a plan made for a proposal runs only with it, and a plan made for none never runs as one.
 */
export type ExecuteOptions = { autopilot?: boolean; onSubmitted?: Sending["onSubmitted"]; proposal?: string;
  beforeClaim?: (plan: Plan, live: Observed) => Promise<string[]> };

/** Executes a saved plan exactly as previewed, under the money lock, or says why it can't. */
export async function* executePlan(id: string, now = () => new Date(), { autopilot = false, onSubmitted, proposal, beforeClaim }: ExecuteOptions = {}): AsyncGenerator<PlanEvent> {
  const plan = loadPlan(id);
  if (plan.proposalId !== proposal) {
    yield { type: "rejected", problems: [plan.proposalId ? "this plan executes an owner-approved proposal: execute the proposal" : "this plan is not the proposal's"] };
    return;
  }
  const lock = await acquireMoneyLock();
  try {
    // Fresh state, read under the lock so nothing else can move it before we act.
    const observed = await observe();
    const { snapshot: live, book, assets } = observed;
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
    const owed = beforeClaim ? await beforeClaim(plan, observed) : [];
    if (owed.length > 0) { yield { type: "rejected", problems: owed }; return; }

    // Claimed before the first action: a plan runs at most once, even if it stops partway. A server told to stop while
    // the checks above ran claims nothing, so a proposal it would execute stays approved.
    assertNotStopping();
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
      const { shortfall, shielded, swapped, refused } = await executeLeg(lock, legFor(current.book, action), action.minAmountOut, plan.source, sending(action));
      const shield = shielded && { amount: shortfall.toString(), status: shielded.status };
      if (!swapped) {
        yield { type: "action", index, action, shield, status: "NOT_SENT", correlationId: "", failureCode: refused?.code ?? null };
        // A swap refused after its shield ends the plan as any refusal between its sends does.
        if (refused) yield { type: "rejected", problems: [refused.reason] };
        return;
      }
      yield { type: "action", index, action, shield, status: swapped.status, correlationId: swapped.correlation_id, failureCode: swapped.failure_code };
      // Anything short of SUCCESS changes the book the rest of the plan assumed: stop.
      if (swapped.status !== "SUCCESS") return;
    }
  } catch (error) {
    // `authorize` refuses a send whose plan no longer holds; the refusal is logged and the plan stops. A server told to
    // stop refuses the next send before its record: the plan stops there too, with what it sent already reported.
    if (!(error instanceof Stopping || (error instanceof LocalRefusal && PLAN_REFUSALS.has(error.code)))) throw error;
    yield { type: "rejected", problems: [error.message] };
  } finally {
    await lock.release();
  }
}
