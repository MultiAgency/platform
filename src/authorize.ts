import type { Policy } from "@near-intents-agent-api/sdk";
import type { Action } from "./agent.js";
import type { api } from "./api.js";
import { mandateDigest } from "./mandate.js";
import type { Plan, PlannedAction } from "./plans.js";
import { ASSETS, outputAssetRefusal } from "./policy.js";
import { grantApproves, type Strategy, strategyDigest } from "./strategy-digest.js";
import { costBps } from "./value.js";
import { NETWORK, OPEN_ACCOUNT_WNEAR, sameTerms, termsOf, type HireTerms } from "./market/x402.js";
import { tokenUsd } from "./valuation.js";
import { breaksCashFloor, cashChange, cashUsd, withinRunCeiling } from "./strategy-value.js";

/**
 * The one authorization rule every money action passes before it is sent. The provider enforces the
 * policy itself (identity, actions, payees, limits, budgets) when the action reaches it; this refuses
 * only what it can't see: a policy not in force, a grant for another purpose, what a swap or order acquires, a
 * public, duplicate, unfunded or over-cap payout, a changed plan, a swap or resting order under the strategy's cash floor, and, before the owner signs, a release the
 * policy no longer allows. Pure: the caller reads the facts, this decides. Facts are typed per purpose, so
 * missing evidence is a type error, never a skipped rule.
 */

export type Purpose = "treasury" | "autopilot" | "payout" | "invoice" | "approval" | "market";
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
/**
 * `cash`: the raw public plus confidential balance of each of the strategy's cash floor assets, read under the money
 * lock; `null` when not read (no floor, or not a planned swap), which a swap that lowers cash under a floor refuses.
 */
type TreasuryFacts = Common & { plan: PlanFacts; strategy: Strategy; tokens: Token[]; cash: Record<string, string> | null };
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
  /** `allowDuplicateHeld`: the payout request opted out of the duplicate check (its caller's requestIds make each payout unique). */
  payout: Common & Funds & { heldPayouts: Transfer[]; allowDuplicateHeld?: boolean };
  invoice: Common & Funds;
  approval: Common;
  /**
   * A market hire's sends (docs/market.md): `hire`, the terms approved (null when the caller named none); `paymentAccount`,
   * the agent's payment key (null when it has none); `payee`, the market's published payee for `near:mainnet`, read under
   * the lock (null when unread or not exactly one; read only for a payment); `keyBalance`, the key's raw USDC at a final
   * block (null when unread).
   */
  market: Common & { hire: HireTerms | null; paymentAccount: string | null; payee: { asset: string; payTo: string } | null;
    keyBalance: string | null };
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
    case "market": return label === "market";
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

/** The policy's per-transaction ceiling bounds the full hire, including funds retained on its payment key. */
export function marketHireCapRefusal(hire: HireTerms, policy: Policy): Refusal | null {
  const asset = `nep141:${hire.asset}`;
  const cap = policy.limits.per_transaction?.[asset];
  return cap !== undefined && BigInt(hire.amount) > BigInt(cap)
    ? refuse("per_transaction_exceeded", `The hire's full price of ${hire.amount} ${asset} exceeds the per-transaction limit of ${cap}`)
    : null;
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

  // The provider checks what a swap or limit order spends, so what it acquires is checked here.
  const buys = outputAssetRefusal(action, policy);
  if (buys) return refuse("asset_out_not_allowed", buys);

  if (purpose === "payout" || purpose === "invoice" || purpose === "approval") {
    // A payout request may also withdraw to an agreed NEAR account, from the confidential balance it is funded in, and
    // the owner may approve one held for its vote (approval rules: user decision, 2026-11-08, "verify like a transfer's").
    // Invoices stay confidential USDC transfers.
    if (action.method === "withdraw" && (purpose === "payout" || purpose === "approval")) {
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
      const { asset } = action.request;
      if (!policy.actions.includes(action.method))
        return refuse("action_not_allowed", `The current policy does not permit ${action.method === "withdraw" ? "withdrawals" : "transfers"}`);
      if (policy.assets !== "any" && !policy.assets.includes(asset)) return refuse("asset_not_allowed", "The current policy does not permit this payment asset");
    }
    // A withdrawal's payee was checked against the policy's withdrawal destinations above. A payout's transfer payee is
    // checked here too: the provider refuses an unlisted one under a code not proven here (`policy_destination_denied`),
    // which would leave the operation unknown and block the agent's sends. Invoices leave it to the provider.
    if ((purpose === "payout" || purpose === "approval") && action.method === "transfer" && !agreedPayees(policy).has(action.request.recipient))
      return refuse("payee_not_agreed", `${action.request.recipient} is not an agreed payee`);
    // The provider refuses an amount over the per-transaction cap under a code not proven here
    // (`policy_transaction_limit_exceeded`), which would leave the operation unknown and block the agent's sends:
    // refused before anything is sent instead.
    const { asset, amount } = action.request;
    const cap = policy.limits.per_transaction?.[asset];
    if (cap !== undefined && BigInt(amount) > BigInt(cap))
      return refuse("per_transaction_exceeded", `${amount} of ${asset} is over the per-transaction limit of ${cap}`);
    if (purpose !== "payout" && (!policy.owner_approval || !policy.confidential))
      return refuse("owner_approval_required", "Invoices and approvals need a confidential policy holding every payment for the owner");
    // The provider holds a payment for the owner's vote without checking the balance, and fails it
    // only after the vote (mainnet, 2026-10-12, docs/mainnet-log.md): an unfunded payout is refused
    // before anyone is asked to approve it.
    if ((c.purpose === "payout" || c.purpose === "invoice") && BigInt(action.request.amount) > BigInt(c.facts.available))
      return refuse("insufficient_balance", `Only ${c.facts.available} of ${action.request.asset} isn't already held for approval, less than ${action.request.amount}: fund the wallet first`);
    // One held payout per recipient, asset and amount spares the owner a second approval of the same thing. A request
    // may opt out: each held payout still needs the owner's vote, so the check guards approvals, not funds.
    if (c.purpose === "payout" && !c.facts.allowDuplicateHeld) {
      const { recipient, asset: token, amount: units } = action.request;
      if (c.facts.heldPayouts.some((h) => h.recipient === recipient && h.asset === token && h.amount === units))
        return refuse("duplicate_held_payout", "A payout with the same recipient, asset and amount is already waiting for approval");
    }
  }

  if (c.purpose === "market") {
    const { hire, paymentAccount, payee, keyBalance } = c.facts;
    if (!hire) return refuse("market_hire_missing", "A market send names the hire it is for");
    if (!paymentAccount) return refuse("payment_key_missing", "This agent has no payment key: a market agent is set up by an app");
    const hireCap = marketHireCapRefusal(hire, policy);
    if (hireCap) return hireCap;
    if (action.method === "x402") {
      // Paid only to the payee the market publishes, in its asset, by the exact scheme, from this agent's own key, for
      // exactly the hire approved (user decision, 2026-11-09).
      const { row, payer } = action.request;
      if (!payee || row.payTo !== payee.payTo || row.asset !== payee.asset)
        return refuse("payee_not_published", "The payment's payee or asset isn't the one the market publishes");
      if (row.scheme !== "exact" || row.network !== NETWORK) return refuse("scheme_not_supported", `Only the exact scheme on ${NETWORK} is paid`);
      if (payer !== paymentAccount) return refuse("payer_not_payment_key", "The payment isn't from this agent's payment key");
      if (action.request.asset !== `nep141:${row.asset}` || action.request.amount !== row.amount)
        return refuse("payment_terms_mismatch", "The payment's recorded asset or amount isn't its row's");
      if (!sameTerms(hire, termsOf(action.request))) return refuse("hire_not_approved", "The payment's terms aren't the hire approved");
      return null;
    }
    if (action.method !== "withdraw") return refuse("market_action_not_allowed", "A market agent only tops up its payment key and pays hires");
    // A top-up: to chain `near`, from the confidential balance, without a memo, only to this agent's payment key, which
    // the policy must name (user decision, 2026-11-09). USDC at most what the hire needs beyond what the key holds.
    const { chain, asset, confidential, memo, recipient, amount } = action.request;
    if (chain !== "near" || !confidential || memo !== undefined || !WITHDRAWN.has(asset))
      return refuse("withdraw_not_allowed", "A top-up is wNEAR or USDC to chain near, from the confidential balance, without a memo");
    if (recipient !== paymentAccount || !agreedWithdrawals(policy).has(recipient))
      return refuse("payee_not_agreed", "A top-up goes only to this agent's payment key, as the policy names it");
    if (policy.assets !== "any" && !policy.assets.includes(asset))
      return refuse("asset_not_allowed", "The policy doesn't permit this asset: the owner adds it to the policy's assets first");
    const cap = policy.limits.per_transaction?.[asset];
    if (cap !== undefined && BigInt(amount) > BigInt(cap))
      return refuse("per_transaction_exceeded", `${amount} of ${asset} is over the per-transaction limit of ${cap}`);
    // wNEAR only opens the key's account: no more than that, whatever the policy's cap (sdk-5f review, 2026-11-10).
    if (asset === ASSETS.wNEAR && BigInt(amount) > BigInt(OPEN_ACCOUNT_WNEAR))
      return refuse("top_up_exceeds_opening", `A wNEAR top-up only opens the payment key's account: at most ${OPEN_ACCOUNT_WNEAR}`);
    if (asset === ASSETS.USDC) {
      if (keyBalance === null) return refuse("payment_key_unread", "The payment key's balance couldn't be read");
      const shortfall = BigInt(hire.amount) - BigInt(keyBalance);
      if (BigInt(amount) > shortfall) return refuse("top_up_exceeds_hire", `The payment key needs at most ${shortfall > 0n ? shortfall : 0n} more for this hire`);
    }
    return null;
  }

  if (c.purpose === "treasury" || c.purpose === "autopilot") {
    // Only a payout request withdraws.
    if (action.method === "withdraw") return refuse("withdraw_not_allowed", "Only a payout request withdraws");
    const { plan: sending, strategy, tokens } = c.facts;
    if (action.method === "limit_order") {
      if (c.purpose === "autopilot") return refuse("order_requires_owner_signature", "A limit order needs the owner's signature over its exact terms");
      if (strategy.cashFloor) return refuse("cash_floor_order_unsupported", "A resting order cannot be placed while the strategy has a cash floor");
      if (sending) return refuse("order_not_plan_bound", "A limit order uses its own signed proposal, not a swap plan");
    }
    // Under a cash floor, a swap without a plan-bound valuation can't be counted against it.
    if ((c.purpose === "autopilot" || strategy.cashFloor) && action.method === "swap" && sending?.leg.type !== "swap")
      return refuse("valuation_unavailable", c.purpose === "autopilot" ? "An automatic swap needs a plan-bound valuation"
        : "Under a cash floor, a swap needs a plan-bound valuation");
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
        const cashFloor = strategy.cashFloor;
        const change = cashFloor ? cashChange(cashFloor, leg, usdIn, floorUsd) : 0;
        // Cash is valued only for a swap that lowers it: one that adds cash is never refused for want of a price.
        if (cashFloor && change < 0) {
          const cash = c.facts.cash === null ? null : cashUsd(cashFloor, c.facts.cash, tokens, now);
          if (cash === null) return refuse("valuation_unavailable", "The cash floor's balance needs a fresh price for each asset it holds");
          if (breaksCashFloor(cashFloor, cash, change))
            return refuse("cash_floor_exceeded", "The swap would take the strategy's cash under its floor");
        }
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
