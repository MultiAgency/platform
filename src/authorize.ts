import type { Policy } from "@near-intents-agent-api/sdk";
import type { Action } from "./agent.js";
import type { api } from "./api.js";
import { mandateDigest } from "./mandate.js";
import type { Plan, PlannedAction } from "./plans.js";
import { ASSETS, outputAssetRefusal } from "./policy.js";
import { grantApproves, type Strategy, strategyDigest } from "./strategy-digest.js";
import { costBps } from "./value.js";
import { tokenUsd } from "./valuation.js";
import { withinRunCeiling } from "./strategy-value.js";

/**
 * The one authorization rule every money action passes before it is sent. The provider enforces the
 * policy itself (identity, actions, payees, limits, budgets) when the action reaches it; this refuses
 * only what it can't see: a policy not in force, a grant for another purpose, what a swap buys, a
 * public, duplicate or unfunded payout, a changed plan, and, before the owner signs, a release the
 * policy no longer allows. Pure: the caller reads the facts, this decides. Facts are typed per purpose, so
 * missing evidence is a type error, never a skipped rule.
 */

export type Purpose = "treasury" | "autopilot" | "payout" | "invoice" | "approval";
type Refusal = { code: string; message: string };

type PolicyView = Awaited<ReturnType<typeof api.getPolicy>>;
type Grant = Awaited<ReturnType<typeof api.listGrants>>[number];
type Token = Awaited<ReturnType<typeof api.getTokens>>[number];
type Transfer = { recipient: string; asset: string; amount: string };

type Common = {
  now: number;
  /** The agent this instance is configured for. */
  agentId: string;
  view: PolicyView;
  /** The live grant whose token this instance holds, if any. */
  grant: Grant | undefined;
};
/** A plan's send, with the leg being sent; `null` for a sweep, which has no plan. */
type PlanFacts = { plan: Plan; leg: PlannedAction } | null;
type TreasuryFacts = Common & { plan: PlanFacts; strategy: Strategy; tokens: Token[] };
/**
 * What a payout may still spend, in the asset's smallest unit: the confidential balance less payouts of
 * that asset already held for approval. The reported balance still includes held payouts (mainnet,
 * 2026-10-13, docs/mainnet-log.md), so they are subtracted here.
 */
type Funds = { available: string };

export type Facts = {
  treasury: TreasuryFacts;
  /** Each earlier submitted swap's recorded value; unknown values remain explicit. */
  autopilot: TreasuryFacts & { submittedSwapValues: readonly (number | null | undefined)[] | null };
  payout: Common & Funds & { heldPayouts: Transfer[] };
  invoice: Common & Funds;
  approval: Common;
};

/** A purpose with the facts it is judged on. */
export type Case = { [P in Purpose]: { purpose: P; facts: Facts[P] } }[Purpose];

const refuse = (code: string, message: string): Refusal => ({ code, message });

/** Payees the owner agreed to: confidential transfer destinations of an `only` policy. Any other mode agrees to no one. */
export function agreedPayees(policy: Policy) {
  if (policy.destinations.mode !== "only") return new Set<string>();
  return new Set(policy.destinations.list.flatMap((d) => d.action === "transfer" && d.confidential ? [d.address] : []));
}

/** NEAR accounts the owner agreed to pay by withdrawal: exact `withdraw` destinations on chain `near`, without a memo, of an `only` policy. */
export function agreedWithdrawals(policy: Policy) {
  if (policy.destinations.mode !== "only") return new Set<string>();
  return new Set(policy.destinations.list.flatMap((d) => d.action === "withdraw" && d.chain === "near" && d.memo === null ? [d.address] : []));
}
/** What a payout may withdraw to NEAR: wNEAR (it arrives as native NEAR) and USDC. */
export const WITHDRAWN = new Set<string>([ASSETS.wNEAR, ASSETS.USDC]);

/** Which grant labels may send for each purpose. Approval votes need no grant. */
function grantAllows(purpose: Purpose, label: string, strategy?: Strategy) {
  switch (purpose) {
    case "treasury": return label === "treasury" || label.startsWith("treasury:");
    case "autopilot": return label.startsWith("treasury:") && grantApproves(label, strategy!);
    case "payout": case "invoice": return label === "payout" || label === "invoices";
    case "approval": return true;
  }
}

/** Why the agent's policy is not in force (missing, unapplied, unsynchronized or frozen), or null when it is. */
export function notInForce(view: PolicyView) {
  if (!view.policy) return "no policy is applied";
  if (view.status !== "APPLIED") return `revision ${view.revision} is not applied (${view.status})`;
  if (!view.provider_policy_synced) return `revision ${view.revision} is not yet synchronized with the provider`;
  if (view.policy.frozen) return "the agent is frozen";
  return null;
}

export function authorize(action: Action, c: Case): Refusal | null {
  const { purpose } = c;
  const { view, grant, now } = c.facts;

  const unenforced = notInForce(view);
  if (unenforced) return refuse("policy_not_in_force", `The policy is not in force: ${unenforced}`);
  const policy = view.policy!; // notInForce refuses a missing policy

  if (purpose !== "approval") {
    // Without one this instance holds no token, and the send would fail locally after it was recorded.
    if (!grant || grant.revoked_at || Date.parse(grant.expires_at) <= now)
      return refuse("grant_missing", "No live grant is held for this agent");
    const strategy = c.purpose === "treasury" || c.purpose === "autopilot" ? c.facts.strategy : undefined;
    if (!grantAllows(purpose, grant.label, strategy))
      return refuse("grant_purpose_denied", `A "${grant.label}" grant does not allow ${purpose} sends`);
  }

  // The provider checks only what a swap spends, so what it buys is checked here, for every purpose.
  const buys = outputAssetRefusal(action, policy);
  if (buys) return refuse("asset_out_not_allowed", buys);

  if (purpose === "payout" || purpose === "invoice" || purpose === "approval") {
    // A payout request may also withdraw to an agreed NEAR account, from the confidential balance it is funded in.
    // Invoices and approvals stay confidential USDC transfers.
    if (action.method === "withdraw" && purpose === "payout") {
      const { chain, asset, confidential, memo, recipient } = action.request;
      if (chain !== "near" || !confidential || memo !== undefined || !WITHDRAWN.has(asset))
        return refuse("withdraw_not_allowed", "Payout withdrawals are wNEAR or USDC to chain near, from the confidential balance, without a memo");
      // The provider refuses an asset outside the policy under a code not proven here, which would leave the operation
      // unknown and block the agent's sends: refused before anything is sent instead.
      if (policy.assets !== "any" && !policy.assets.includes(asset))
        return refuse("asset_not_allowed", "The policy doesn't permit this asset: the owner adds it to the policy's assets first");
      if (!agreedWithdrawals(policy).has(recipient))
        return refuse("payee_not_agreed", `${recipient} is not a NEAR account this policy agrees to pay by withdrawal`);
    } else if (action.method !== "transfer" || action.request.asset !== ASSETS.USDC || !action.request.confidential)
      return refuse("transfer_not_allowed", "Payouts are confidential USDC transfers");
    // The provider checked payee and cap when the payment was requested, under the policy then; the
    // owner signs now, so what the policy no longer allows is refused here.
    if (purpose === "approval") {
      const { recipient, asset, amount } = action.request;
      if (!policy.actions.includes("transfer")) return refuse("action_not_allowed", "The current policy does not permit transfers");
      if (policy.assets !== "any" && !policy.assets.includes(asset)) return refuse("asset_not_allowed", "The current policy does not permit this payment asset");
      if (!agreedPayees(policy).has(recipient)) return refuse("payee_not_agreed", `${recipient} is not an agreed payee`);
      const cap = policy.limits.per_transaction?.[asset];
      if (cap !== undefined && BigInt(amount) > BigInt(cap))
        return refuse("per_transaction_exceeded", `${amount} of ${asset} is over the per-transaction limit of ${cap}`);
    }
    if (purpose !== "payout" && (!policy.owner_approval || !policy.confidential))
      return refuse("owner_approval_required", "Invoices and approvals need a confidential policy holding every payment for the owner");
    // The provider holds a payment for the owner's vote without checking the balance, and fails it
    // only after the vote (mainnet, 2026-10-12, docs/mainnet-log.md): an unfunded payout is refused
    // before anyone is asked to approve it.
    if ((c.purpose === "payout" || c.purpose === "invoice") && BigInt(action.request.amount) > BigInt(c.facts.available))
      return refuse("insufficient_balance", `Only ${c.facts.available} of ${action.request.asset} isn't already held for approval, less than ${action.request.amount}: fund the wallet first`);
    if (c.purpose === "payout") {
      const { recipient, asset: token, amount: units } = action.request;
      if (c.facts.heldPayouts.some((h) => h.recipient === recipient && h.asset === token && h.amount === units))
        return refuse("duplicate_held_payout", "A payout with the same recipient, asset and amount is already waiting for approval");
    }
  }

  if (c.purpose === "treasury" || c.purpose === "autopilot") {
    // Only a payout request withdraws.
    if (action.method === "withdraw") return refuse("withdraw_not_allowed", "Only a payout request withdraws");
    const { plan: sending, strategy, tokens } = c.facts;
    if (c.purpose === "autopilot" && action.method === "swap" && sending?.leg.type !== "swap")
      return refuse("valuation_unavailable", "An automatic swap needs a plan-bound valuation");
    if (sending) {
      const { plan, leg } = sending;
      if (!Number.isFinite(Date.parse(plan.expiresAt)) || now >= Date.parse(plan.expiresAt)) return refuse("plan_expired", "The plan expired");
      if (plan.agentId !== c.facts.agentId) return refuse("plan_agent_changed", "The plan was made for another agent");
      if (strategyDigest(strategy) !== plan.strategyDigest) return refuse("strategy_changed", "The owner's strategy changed since the plan");
      if (view.revision !== plan.policyRevision || mandateDigest(policy) !== plan.policyDigest)
        return refuse("plan_policy_changed", "The policy changed since the plan");
      if (leg.type === "swap") {
        const input = tokens.find((t) => t.asset_id === leg.from);
        const output = tokens.find((t) => t.asset_id === leg.to);
        // The swap's full value is checked before its prerequisite shield and again before the swap.
        const usdIn = tokenUsd(leg.amount, input, now);
        const floorUsd = tokenUsd(leg.minAmountOut, output, now);
        if (usdIn === null || floorUsd === null || usdIn <= 0 || floorUsd <= 0)
          return refuse("valuation_unavailable", "The swap needs fresh prices and finite positive input and output-floor values");
        const cost = costBps(usdIn, floorUsd);
        if (!Number.isFinite(cost) || cost > strategy.maxCostBps)
          return refuse("swap_cost_exceeded", "The swap's output floor exceeds the strategy's cost limit");
        if (c.purpose === "autopilot") {
          const prior = c.facts.submittedSwapValues;
          const within = Array.isArray(prior) ? withinRunCeiling([...prior, usdIn], strategy.autopilot.maxUsd) : null;
          if (within === null)
            return refuse("valuation_unavailable", "The value of this plan's submitted swaps is unavailable");
          if (!within)
            return refuse("autopilot_limit_exceeded", "The plan's submitted swaps plus this swap exceed the auto-execute limit");
        }
      }
    }
  }
  return null;
}
