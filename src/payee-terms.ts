import type { api } from "./api.js";
import { agreedPayees, notInForce } from "./authorize.js";
import type { PayeeTerms } from "./contract/payee-policy.js";
import { mandateDigest } from "./mandate.js";

type PolicyView = Awaited<ReturnType<typeof api.getPolicy>>;

/**
 * What one payee may see of the provider's policy view, under the owner's payee disclosure: their own destination entries
 * (a transfer to their account, or a withdrawal to it on NEAR), the per-transaction caps of the assets the agent may
 * spend, `owner_approval`, `frozen`, whether the policy is in force, its revision. Never other entries,
 * budgets, period limits, usage or the provider's own hash. The mandate digest only with `digest`, which the gateway sets
 * from the owner's opt-in: it would let a payee confirm a guess of the rest of the policy. Pure.
 */
export function payeeTerms(view: PolicyView, payee: string, agentId: string, now = new Date(), { digest = false }: { digest?: boolean } = {}): PayeeTerms {
  const policy = view.policy;
  const terms = policy && (() => {
    const enabled = (action: "transfer" | "withdraw") => policy.actions.includes(action);
    const destinations = policy.destinations.list.flatMap((d): NonNullable<PayeeTerms["terms"]>["destinations"] => {
      if (d.address !== payee) return [];
      if (d.action === "transfer") return [{ action: "transfer", address: d.address, confidential: d.confidential, enabled: enabled("transfer") }];
      return d.chain === "near" ? [{ action: "withdraw", chain: "near", address: d.address, memo: d.memo, enabled: enabled("withdraw") }] : [];
    });
    const spends = (asset: string) => policy.assets === "any" || policy.assets.includes(asset);
    return { frozen: policy.frozen, ownerApproval: policy.owner_approval, mode: policy.destinations.mode, agreed: agreedPayees(policy).has(payee), destinations,
      perTransaction: Object.fromEntries(Object.entries(policy.limits.per_transaction ?? {}).filter(([asset]) => spends(asset))) };
  })();
  return { agentId, payee, observedAt: now.toISOString(), revision: view.revision, status: view.status, appliedAt: view.applied_at,
    synced: view.provider_policy_synced, notInForce: notInForce(view), terms, ...(digest && policy ? { digest: mandateDigest(policy) } : {}) };
}
