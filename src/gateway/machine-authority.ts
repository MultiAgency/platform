import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { z } from "zod";
import { daoPolicy } from "../chain.js";
import type { DaoPolicy } from "../contract/dao-roles.js";
import { daoOwner } from "../dao-owner.js";
import type { Router } from "../router.js";
import { accessOf, type Access } from "./roles.js";
import { agentOrigin } from "./agent-origin.js";
type NearOwner = Awaited<ReturnType<typeof daoOwner>>;
type Agent = { name: string; owner: string; port: number; envFile?: string };
// Both null: a server whose agent isn't created yet. Otherwise both present.
const identity = z.object({ agentId: z.string().min(1).nullable(), owner: z.object({ type: z.literal("near"), account_id: z.string().min(1) }).nullable() })
  .refine(value => (value.agentId === null) === (value.owner === null));

/** A check whose source didn't answer (a chain read, or the agent's server): nothing is known, so nothing is decided. */
export class AuthorityUnanswered extends Error {
  constructor() { super("The agent's ownership couldn't be checked now"); }
}

/**
 * A live wallet owner's authority over its agent, read from the agent's server now: `agentId: null` while the server
 * reports no agent created yet. No cached or fallback evidence, and no DAO owner. `null` is an answer (not this
 * owner's, or a DAO's); a check that went unanswered throws `AuthorityUnanswered`.
 */
export async function resolveWalletAuthority(account: string, agent: Agent): Promise<{ access: Access; agentId: string | null } | null> {
  if (account !== agent.owner) return null;
  let answer: unknown;
  try {
    if (await daoPolicy(agent.owner)) return null;
    answer = await ownerIdentity(agent);
  } catch { throw new AuthorityUnanswered(); }
  const parsed = identity.safeParse(answer);
  if (!parsed.success) throw new AuthorityUnanswered();
  if (parsed.data.owner && parsed.data.owner.account_id !== account) return null;
  return { access: accessOf(account, { account, policy: null, signer: account })!, agentId: parsed.data.agentId };
}

/** The agent's provider ID and owner, as its server on loopback reports them now. */
function ownerIdentity(agent: Agent) {
  const link = new RPCLink({ origin: agentOrigin(agent), url: "/rpc", headers: { "x-gateway": "owner-check" } });
  const client: RouterClient<Router> = createORPCClient(link);
  return client.ownerIdentity(undefined, { signal: AbortSignal.timeout(3_000) });
}

/**
 * What a DAO's own vote gave an app (docs: coordination/p5-treasury-dao-consent.md): it may propose, execute and
 * manage within the consent's scopes, never sign or vote. Each owner signature stays a DAO vote the platform files.
 */
export const DAO_APP_ACCESS: Access = { canSign: false, canPropose: true, canVote: false, canExecute: true, canManage: true };
/** The chain reads a DAO owner's authority needs; tests pass their own. */
export type DaoOwnerReads = { policy: (dao: string) => Promise<DaoPolicy | null>; owner: (dao: string) => Promise<NearOwner> };
export const chainDaoOwner: DaoOwnerReads = { policy: daoPolicy, owner: daoOwner };

/**
 * A DAO owner's authority over its agent now: the configured owner is a Sputnik DAO, and the agent's server reports it
 * owned by the DAO's derived account (or not created yet, `agentId: null`). `null` is an answer (not a DAO, or owned by
 * another account); a read that went unanswered throws `AuthorityUnanswered`.
 */
export async function resolveDaoAuthority(agent: Agent, reads: DaoOwnerReads = chainDaoOwner) {
  let policy: DaoPolicy | null, signer: NearOwner, answer: unknown;
  try {
    policy = await reads.policy(agent.owner);
    if (!policy) return null;
    signer = await reads.owner(agent.owner);
    answer = await ownerIdentity(agent);
  } catch { throw new AuthorityUnanswered(); }
  const parsed = identity.safeParse(answer);
  if (!parsed.success) throw new AuthorityUnanswered();
  if (parsed.data.owner && parsed.data.owner.account_id !== signer.account_id) return null;
  return { access: DAO_APP_ACCESS, agentId: parsed.data.agentId, policy, signer };
}

/** Machine delegation requires a live, established wallet owner and an agent that exists. Unanswered refuses, as before. */
export async function resolveMachineAccess(account: string, agent: Agent): Promise<{ access: Access; agentId: string } | null> {
  const authority = await resolveWalletAuthority(account, agent).catch((error: unknown) => {
    if (error instanceof AuthorityUnanswered) return null;
    throw error;
  });
  return authority?.agentId ? { access: authority.access, agentId: authority.agentId } : null;
}


/** Restricting existing access needs current DAO management rights, but no product/provider reads. */
export async function resolveMachineManagement(account: string, agent: Agent): Promise<{ dao: boolean } | null> {
  if (account === agent.owner) return { dao: false };
  try {
    const policy = await daoPolicy(agent.owner);
    return policy && accessOf(account, { account: agent.owner, signer: agent.owner, policy })?.canManage
      ? { dao: true } : null;
  } catch { return null; }
}
