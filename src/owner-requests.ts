import { PublicError } from "./public-error.js";
import type { OwnerWallet, Policy } from "@near-intents-agent-api/sdk";
import { agentId } from "./env.js";
import { api } from "./api.js";
import { type AgentRole, payoutPolicy, treasuryPolicy } from "./policy.js";
import { mandateDigest, type ReviewedPolicy } from "./mandate.js";
import { currentWorkOrder, workOrderPolicy } from "./work-order-store.js";

/**
 * The owner actions this treasury uses, built once for both signers: the CLI's owner key and
 * the dashboard's connected wallet.
 */
export const ownerRequests = {
  agent_create: (owner: OwnerWallet, role: AgentRole = "treasury", payees: string[] = []) => {
    const order = currentWorkOrder();
    if (order && (owner.type !== "near" || owner.account_id !== order.owner.account_id || owner.public_key !== order.owner.public_key))
      throw new PublicError("The work order owner changed. Preserve the original order and review its authority.");
    return {
      type: "agent_create",
      name: order ? "Work order" : role === "payout" ? "Payouts" : "Agentic Treasury",
      owner,
      policy: order ? workOrderPolicy(order) : role === "payout" ? payoutPolicy(payees) : treasuryPolicy,
    } as const;
  },
  agent_freeze: () => ({ type: "agent_freeze", agent_id: agentId() }) as const,
  agent_unfreeze: () => ({ type: "agent_unfreeze", agent_id: agentId() }) as const,
};

/** A transfer destination in the policy: the treasury funds may return to, or an agreed payee. */
type TransferDestination = { address: string; confidential: boolean };

/** What the owner may change in one update; anything left out keeps its current value. */
export type PolicyChanges = Partial<Pick<Policy, "assets" | "owner_approval" | "limits" | "max_actions_per_hour" | "budget">> & {
  /** Whether the agent may swap between its assets. */
  swap?: boolean;
  /** The treasury it may return funds to and the payees in its agreement. */
  destinations?: TransferDestination[];
};

/**
 * The agent's current policy with `changes` applied. After an edit, transfers are on exactly while the destination list
 * has an entry, so funds cannot leave without a destination the owner signed. A payout agent is created with transfers on
 * and no payees (`payoutPolicy`), so its first payee changes only `destinations`; removing the last turns transfers off.
 */
export async function policyRequest(changes: PolicyChanges, expectedPolicy: ReviewedPolicy) {
  return (await policyChange(changes, expectedPolicy)).request;
}

/** The provider request for a reviewed policy edit, and the policy in force it replaces. */
export async function policyChange({ swap, destinations, ...asked }: PolicyChanges, expectedPolicy: ReviewedPolicy) {
  // A field sent as undefined (the serializer keeps the key) leaves it as it is in force.
  const fields = Object.fromEntries(Object.entries(asked).filter(([, value]) => value !== undefined));
  const id = agentId();
  const { policy, revision } = await api.getPolicy(id);
  if (!policy || revision === null) throw new PublicError("The agent's policy is not applied yet");
  if (!expectedPolicy || expectedPolicy.revision !== revision || expectedPolicy.digest !== mandateDigest(policy))
    throw new PublicError("The policy changed since review. Refresh the policy and review all changes before signing.");
  const transfers = destinations ?? policy.destinations.list.flatMap((d) => (d.action === "transfer" ? [d] : []));
  const swaps = swap ?? policy.actions.includes("swap");
  const next: Policy = {
    ...policy,
    ...fields,
    actions: [
      ...policy.actions.filter((a) => a !== "swap" && a !== "transfer"),
      ...(swaps ? (["swap"] as const) : []),
      ...(transfers.length ? (["transfer"] as const) : []),
    ],
    destinations: {
      mode: "only",
      list: [
        ...policy.destinations.list.filter((d) => d.action !== "transfer"),
        ...transfers.map(({ address, confidential }) => ({ action: "transfer" as const, address, confidential })),
      ],
    },
  };
  return { request: { type: "policy_update", agent_id: id, expected_revision: revision, policy: next } as const, current: policy };
}
