import { PublicError } from "./public-error.js";
import type { OwnerWallet, Policy } from "@near-intents-agent-api/sdk";
import { agentId } from "./env.js";
import { api } from "./api.js";
import { type AgentRole, marketPolicy, payoutPolicy, treasuryPolicy } from "./policy.js";
import { fundingProofCreationPolicy } from "./market/creation-policy.js";
import { paymentKey } from "./market/payment-key.js";
import { mandateDigest, type ReviewedPolicy } from "./mandate.js";
import { currentWorkOrder, workOrderPolicy } from "./work-order-store.js";

/**
 * The owner actions this treasury uses, built once for both signers: the CLI's owner key and
 * the dashboard's connected wallet.
 */
export const ownerRequests = {
  agent_create: (owner: OwnerWallet, role: AgentRole = "treasury", payees: string[] = [], creationProfile?: "market-funding-proof") => {
    const order = currentWorkOrder();
    if (creationProfile !== undefined && (creationProfile !== "market-funding-proof" || order || payees.length || role !== "market"))
      throw new PublicError("The funding-proof creation profile requires a wallet-owned hosted Market reservation without payees or a work order.");
    if (order && (owner.type !== "near" || owner.account_id !== order.owner.account_id || owner.public_key !== order.owner.public_key))
      throw new PublicError("The work order owner changed. Preserve the original order and review its authority.");
    return {
      type: "agent_create",
      name: order ? "Work order" : role === "payout" ? "Payouts" : role === "market" ? "Market hires" : "Agentic Treasury",
      owner,
      policy: creationProfile ? fundingProofCreationPolicy(owner) : order ? workOrderPolicy(order) : role === "payout" ? payoutPolicy(payees) : role === "market" ? marketPolicy(paymentKey().account) : treasuryPolicy,
    } as const;
  },
  agent_freeze: () => ({ type: "agent_freeze", agent_id: agentId() }) as const,
  agent_unfreeze: () => ({ type: "agent_unfreeze", agent_id: agentId() }) as const,
  agent_archive: () => ({ type: "agent_archive", agent_id: agentId() }) as const,
  agent_restore: () => ({ type: "agent_restore", agent_id: agentId() }) as const,
};

/** A transfer destination in the policy: the treasury funds may return to, or an agreed payee. */
type TransferDestination = { address: string; confidential: boolean };
/** A NEAR account the agent pays by withdrawal to chain `near`, without a memo. */
type WithdrawalDestination = { address: string };
const nearWithdrawal = (d: Policy["destinations"]["list"][number]) => d.action === "withdraw" && d.chain === "near" && d.memo === null;

/** What the owner may change in one update; anything left out keeps its current value. */
export type PolicyChanges = Partial<Pick<Policy, "assets" | "owner_approval" | "limits" | "max_actions_per_hour" | "budget">> & {
  /** Whether the agent may swap between its assets. */
  swap?: boolean;
  /** Explicit owner-signed permission to place limit orders, with its price-deviation ceiling. */
  limit_order?: { enabled: true; max_deviation_bps: number } | { enabled: false };
  /** The treasury it may return funds to and the payees in its agreement. */
  destinations?: TransferDestination[];
  /** The NEAR accounts it pays by withdrawal. */
  withdrawals?: WithdrawalDestination[];
};

/**
 * The agent's current policy with `changes` applied. After an edit, transfers are on exactly while there is a transfer
 * destination, so funds cannot leave without a destination the owner signed; an edit naming `withdrawals` turns
 * withdrawals on exactly while there is a withdrawal destination, and any other edit leaves them as they are. A payout agent is created with transfers on and no payees (`payoutPolicy`), so its
 * first payee changes only `destinations`; removing the last turns transfers off. Its first withdrawal payee turns
 * withdrawals on (an on-chain edit, signed on the confirm page through an app).
 */
export async function policyRequest(changes: PolicyChanges, expectedPolicy: ReviewedPolicy) {
  return (await policyChange(changes, expectedPolicy)).request;
}

/** The provider request for a reviewed policy edit, and the policy in force it replaces. */
export async function policyChange({ swap, limit_order: limitOrder, destinations, withdrawals, ...asked }: PolicyChanges, expectedPolicy: ReviewedPolicy) {
  if (limitOrder?.enabled && (!Number.isInteger(limitOrder.max_deviation_bps) || limitOrder.max_deviation_bps < 0 || limitOrder.max_deviation_bps > 300))
    throw new PublicError("A limit order's maximum price deviation must be an integer from 0 to 300 basis points.");
  // A field sent as undefined (the serializer keeps the key) leaves it as it is in force.
  const fields = Object.fromEntries(Object.entries(asked).filter(([, value]) => value !== undefined));
  const id = agentId();
  const { policy, revision } = await api.getPolicy(id);
  if (!policy || revision === null) throw new PublicError("The agent's policy is not applied yet");
  if (!expectedPolicy || expectedPolicy.revision !== revision || expectedPolicy.digest !== mandateDigest(policy))
    throw new PublicError("The policy changed since review. Refresh the policy and review all changes before signing.");
  const transfers = destinations ?? policy.destinations.list.flatMap((d) => (d.action === "transfer" ? [d] : []));
  const toNear = withdrawals ?? policy.destinations.list.flatMap((d) => (nearWithdrawal(d) ? [{ address: d.address }] : []));
  // Withdrawal destinations the platform doesn't manage (another chain, a memo) are kept as they are. Withdrawals change
  // only when the edit names `withdrawals`: any other edit leaves them exactly as they are, on or off.
  const others = policy.destinations.list.filter((d) => d.action !== "transfer" && !nearWithdrawal(d));
  const withdraws = withdrawals === undefined ? policy.actions.includes("withdraw") : toNear.length > 0 || others.some((d) => d.action === "withdraw");
  const swaps = swap ?? policy.actions.includes("swap");
  // An unrelated edit preserves both the provider's existing permission and its deviation rule.
  // An explicit opt-out removes both, so a later opt-in must name its ceiling again.
  const { limit_order: previousLimitOrder, ...basePolicy } = policy;
  const orderRule = limitOrder === undefined ? previousLimitOrder
    : limitOrder.enabled ? { max_deviation_bps: limitOrder.max_deviation_bps } : undefined;
  const next: Policy = {
    ...basePolicy,
    ...fields,
    ...(orderRule !== undefined && { limit_order: orderRule }),
    actions: [
      ...policy.actions.filter((a) => a !== "swap" && a !== "transfer" && a !== "withdraw" && (limitOrder === undefined || a !== "limit_order")),
      ...(swaps ? (["swap"] as const) : []),
      ...(transfers.length ? (["transfer"] as const) : []),
      ...(withdraws ? (["withdraw"] as const) : []),
      ...(limitOrder?.enabled ? (["limit_order"] as const) : []),
    ],
    destinations: {
      mode: "only",
      list: [
        ...others,
        ...transfers.map(({ address, confidential }) => ({ action: "transfer" as const, address, confidential })),
        ...toNear.map(({ address }) => ({ action: "withdraw" as const, chain: "near", address, memo: null })),
      ],
    },
  };
  return { request: { type: "policy_update", agent_id: id, expected_revision: revision, policy: next } as const, current: policy };
}
