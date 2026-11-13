import { marketStageKey, readMarketBindings, readOps, type MarketBinding, type MarketStage, type Op } from "../ops.js";
import { isTerminal, isUnknownOutcome } from "../operation-status.js";
import { parseAllocation } from "./allocation-types.js";
import { requestKey } from "../request-key.js";

/** A provider outcome without matching final landing proof needs review, even if it says SUCCESS. */
export function marketFundingNeedsReview(binding: MarketBinding, ops: readonly Op[]): boolean {
  if (binding.landed.usdc) return true;
  return (["open", "usdc"] as const).some(stage => {
    if (binding.landed[stage]) return false;
    const op = ops.find(item => item.idempotencyKey === marketStageKey(binding.idempotencyKey, stage));
    if (!op || op.refused !== undefined) return false;
    // A lost acceptance reply leaves no provider identity to poll. It requires review, never another submission.
    return (op.submissionState === "SUBMISSION_ATTEMPTED" && !op.correlationId) ||
      (op.status !== undefined && (isTerminal(op.status) || isUnknownOutcome(op.status)));
  });
}

/** Archive does not cancel an earlier withdrawal: release waits until its destination credit is proven.
 * Submitted legacy top-ups have no supported automatic proof or clearance. Proven landed funds remain subject to
 * release's existing explicit balance choice and keep their binding on restoration. */
export function hasUnprovenMarketFunding(ops: readonly Op[], bindings: readonly MarketBinding[]): boolean {
  const landed = new Set(bindings.flatMap(binding => (["open", "usdc"] as const)
    .filter(stage => binding.landed[stage]).map(stage => marketStageKey(binding.idempotencyKey, stage))));
  return ops.some(op => op.kind === "market-topup" && op.method === "withdraw" && op.refused === undefined &&
    (op.submissionState === "SUBMISSION_ATTEMPTED" || op.correlationId !== undefined) && !landed.has(op.idempotencyKey));
}

/** A pre-binding top-up has no request-ID binding. Its eventual credit cannot be assigned to a later hire. */
export function legacyMarketFunding(paymentAccount: string): Op | null {
  const boundStages = new Set(readMarketBindings().flatMap(binding =>
    [marketStageKey(binding.idempotencyKey, "open"), marketStageKey(binding.idempotencyKey, "usdc")]));
  return readOps().find(op => op.kind === "market-topup" && op.method === "withdraw" &&
    op.request.recipient === paymentAccount && !boundStages.has(op.idempotencyKey) &&
    (op.submissionState === "SUBMISSION_ATTEMPTED" || op.correlationId !== undefined)) ?? null;
}

/** Submitted credits, and landed funds reserved to their still-unpaid hire, belong to one payment key. */
export function pendingMarketFunding(paymentAccount: string, continuingBindingKey?: string):
  { binding: MarketBinding; stage: MarketStage; op: Op } | null {
  const ops = new Map(readOps().map(op => [op.idempotencyKey, op]));
  const bindings = readMarketBindings();
  for (const binding of bindings) {
    if (binding.paymentAccount !== paymentAccount) continue;
    if (binding.fundingOnly && binding.allocation && continuingBindingKey) {
      const allocation = parseAllocation(binding.allocation);
      const target = bindings.find(b => b.idempotencyKey === continuingBindingKey);
      // This is only a routing exemption. Dispatch must verify fresh owner/key, policy and expiry before a send.
      if (requestKey(allocation.target.actor, allocation.target.requestId) === continuingBindingKey &&
          target?.fundingSource?.message === binding.allocation.message && target.fundingSource.signature === binding.allocation.signature) continue;
    }
    if (binding.refused && !binding.fundingOnly) continue;
    // A proven local refusal or never-submitted stage closes this hire. Earlier landed opening funds may remain,
    // but no later credit can arrive for the refused stage and this request cannot continue to x402.
    if (!binding.fundingOnly && (["open", "usdc"] as const).some(stage =>
      ops.get(marketStageKey(binding.idempotencyKey, stage))?.refused !== undefined)) continue;
    for (const stage of ["open", "usdc"] as const) {
      if (binding.landed[stage]) continue;
      const op = ops.get(marketStageKey(binding.idempotencyKey, stage));
      if (op && op.refused === undefined && (op.submissionState === "SUBMISSION_ATTEMPTED" || op.correlationId))
        return { binding, stage, op };
    }
    // Once a credit lands, its funds remain reserved for the original request until its x402 operation is recorded
    // or the binding is closed. Another request must not consume them and strand a later same-ID approval.
    if (binding.idempotencyKey !== continuingBindingKey && !ops.has(binding.idempotencyKey)) {
      for (const stage of ["usdc", "open"] as const) {
        const op = ops.get(marketStageKey(binding.idempotencyKey, stage));
        if (binding.landed[stage] && op) return { binding, stage, op };
      }
    }
  }
  return null;
}
