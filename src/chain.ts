import type { Intent } from "@near-intents-agent-api/sdk";
import { AccountDoesNotExistError, FunctionCallError, Near } from "near-kit";
import { type DaoPolicy, groupOf, permits } from "./contract/dao-roles.js";
import { ASSETS } from "./policy.js";

import { fastnearAuthorization } from "./fastnear.js";
export { fastnearAuthorization, fastnearPost, transactionsApi } from "./fastnear.js";

/** The transaction a NEP-366 payload asks for, from `signerId`, ready to sign as a delegate action. */
export const delegateTransaction = (near: Near, signerId: string, { receiverId, actions }: Extract<Intent, { standard: "nep366" }>["payload"]) =>
  actions.reduce(
    (tx, { params }) => tx.functionCall(receiverId, params.methodName, params.args, { gas: params.gas as never, attachedDeposit: BigInt(params.deposit) }),
    near.transaction(signerId),
  );

/** How every `Near` client here reaches mainnet: the keyed FastNear host when there is a key. */
const rpcUrl = process.env.NEAR_RPC_URL?.trim() || (process.env.FASTNEAR_API_KEY ? "https://rpc.mainnet.fastnear.com" : "https://free.rpc.fastnear.com");
export const mainnet = {
  network: {
    rpcUrl,
    networkId: "mainnet",
  },
  headers: fastnearAuthorization(rpcUrl),
};

/** Read-only NEAR access for the treasury view; owner signing builds its own client in owner.ts. */
const near = new Near(mainnet);

export const contractOf = (asset: string) => asset.replace(/^nep141:/, "");


type DaoProposal = {
  id: number;
  proposer: string;
  description: string;
  status: string;
  kind: Record<string, Record<string, unknown>> | string;
};

/** Sputnik thresholds are a vote weight ("2") or a share of the role ([1, 2]). */
const threshold = (t: unknown) =>
  Array.isArray(t) ? `${t[0]}/${t[1]} of the role` : `${t} vote${t === "1" ? "" : "s"}`;

/**
 * A Sputnik DAO view, or null when the chain says the account can't answer it: no such account, no
 * contract, or no such method (AccountDoesNotExistError, FunctionCallError; mainnet RPC, 2026-10-13).
 * Any other failure, such as the RPC being unreachable, is no answer at all and throws.
 */
async function daoView<T>(accountId: string, method: string): Promise<T | null> {
  try {
    return (await near.view<T>(accountId, method)) ?? null;
  } catch (error) {
    if (error instanceof AccountDoesNotExistError || error instanceof FunctionCallError) return null;
    throw error;
  }
}

/** A Sputnik DAO's policy; null for any other account, which is treated as a plain NEAR account. */
export const daoPolicy = (accountId: string) => daoView<DaoPolicy>(accountId, "get_policy");

/** The id the DAO's next proposal will get (Sputnik's `get_last_proposal_id`); null for an account that isn't a DAO. */
export const nextProposalId = (accountId: string) => daoView<number>(accountId, "get_last_proposal_id");

export async function isDao(accountId: string) {
  return (await daoPolicy(accountId)) !== null;
}

/**
 * The account the agent works for: its balances and, for a DAO, the council that votes on
 * funding and payee agreements. Both balances are raw integer strings, as every amount on the wire: `near` is the
 * account's yoctoNEAR (`view_account` `amount`, including what storage reserves), `usdc` its USDC at 6 decimals.
 */
export async function describeTreasury(accountId: string) {
  const [policy, account, usdc] = await Promise.all([
    daoPolicy(accountId),
    near.rpc.getAccount(accountId),
    near.view<string>(contractOf(ASSETS.USDC), "ft_balance_of", { account_id: accountId }),
  ]);
  return { accountId, dao: policy && council(policy), balances: { near: account.amount, usdc: usdc ?? "0" } };
}

/** A DAO's members, and who approves a FunctionCall proposal (how funding is filed) with how many votes. */
export function council(policy: DaoPolicy) {
  return {
    members: [...new Set(policy.roles.flatMap(groupOf))],
    approvers: policy.roles
      .filter((r) => permits(r.permissions, "call", "VoteApprove"))
      .map((r) => ({ role: r.name, threshold: threshold(r.vote_policy.call?.threshold ?? policy.default_vote_policy.threshold) })),
  };
}

/**
 * Payees the DAO has already voted to pay: receivers of its approved public transfer proposals.
 * They are candidates for the agent's agreement; the owner still signs them into the policy.
 * Implicit (64-hex) receivers are skipped: deposit addresses, such as Trezu's for funding its
 * private side, are implicit accounts and look the same as a payee on chain.
 */
export async function daoPayees(accountId: string) {
  const last = await near.view<number>(accountId, "get_last_proposal_id");
  if (!last) return [];
  const proposals =
    (await near.view<DaoProposal[]>(accountId, "get_proposals", { from_index: Math.max(0, last - 100), limit: 100 })) ?? [];
  const payees = new Map<string, { proposalId: number; description: string }>();
  for (const p of proposals) {
    if (p.status !== "Approved" || typeof p.kind !== "object" || !p.kind.Transfer) continue;
    const receiver = p.kind.Transfer.receiver_id as string;
    if (/^[0-9a-f]{64}$/.test(receiver)) continue;
    payees.set(receiver, { proposalId: p.id, description: p.description });
  }
  return [...payees].map(([address, why]) => ({ address, ...why }));
}

/**
 * Whether the account exists on chain: false only when the chain says it doesn't (AccountDoesNotExistError,
 * mainnet RPC, 2026-10-13, an unfunded implicit account included). A failed read throws: near-kit's own
 * `accountExists` answers false to any error.
 */
export async function accountExists(accountId: string, options?: { finality: "final" }) {
  try {
    await near.getAccount(accountId, options);
    return true;
  } catch (error) {
    if (error instanceof AccountDoesNotExistError) return false;
    throw error;
  }
}

/**
 * Whether the account is registered (NEP-145) on a token contract: `null` from `storage_balance_of` means it isn't
 * (USDC, mainnet RPC, 2026-10-29T14:44Z: an existing unregistered account, and a missing one). A failed read, or an empty answer, throws.
 */
export async function storageRegistered(contract: string, accountId: string, options?: { finality: "final" }) {
  const balance = await near.view(contract, "storage_balance_of", { account_id: accountId }, options);
  if (balance === undefined) throw new Error(`${contract} gave no storage balance answer`);
  return balance !== null;
}

export { fundingTransaction } from "./contract/funding.js";
