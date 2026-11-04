import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { z } from "zod";
import { daoPolicy } from "../chain.js";
import { accessOf, type Owner } from "../contract/dao-roles.js";
import { daoOwner } from "../dao-owner.js";
import type { Router } from "../router.js";
import { agentOrigin } from "./agent-origin.js";

/**
 * What a signed-in account may do with each agent, read from the agent's owner itself. A Sputnik DAO's
 * members are in one of its groups; any other owner account is its own only member, and signs as
 * owner directly, so only that account accesses its agents. DAO capabilities come from the group's
 * and Everyone's on-chain permissions. Anyone outside its groups is refused. Read again at most every
 * minute, so a member the DAO removes loses access within a minute.
 *
 * The configured owner is checked against the agent itself: an agent its own server reports owned by
 * anyone else is closed to everyone, so a wrong `owner` in the configuration can't hand an agent to
 * the wrong people.
 */

import type { Access } from "../contract/permissions.js";
export type { Access, Owner };
export { accessOf };
/** The agent's owner as its server reports it (the Agent API's), or null before the agent exists. */
export type AgentOwner = { type: string; account_id?: string } | null;

/** Whether the agent answers to the configured owner: not created yet (the owner sets it up), or owned by its signer. */
export const ownedBy = (agent: AgentOwner, owner: Owner) => agent === null || (agent.type === "near" && agent.account_id === owner.signer);

const CACHE_MS = 60_000;
const owners = new Map<string, { owner: Owner; at: number }>();

/** An owner account and, when it is a Sputnik DAO, its policy and signing account; at most a minute old. */
export async function ownerOf(account: string, now = Date.now()): Promise<Owner> {
  const hit = owners.get(account);
  if (hit && now - hit.at <= CACHE_MS) return hit.owner;
  const policy = await daoPolicy(account);
  const owner = { account, policy, signer: policy ? (await daoOwner(account)).account_id : account };
  owners.set(account, { owner, at: now });
  return owner;
}

type Agent = { name: string; owner: string; port: number; envFile?: string };
const reported = new Map<string, { owner: AgentOwner; at: number }>();
/** One read per agent at a time: requests arriving while it's in flight share it. */
const reading = new Map<string, Promise<AgentOwner | undefined>>();
// An absent configured agent is distinct from a configured agent with missing ownership evidence.
const identity = z.object({
  agentId: z.string().min(1).nullable(),
  owner: z.object({ type: z.string().min(1), account_id: z.string().optional() }).nullable(),
}).refine(value => (value.agentId === null) === (value.owner === null));

/**
 * The agent's owner as its server on loopback reports it, at most a minute old. While the server
 * doesn't answer (restarting), the last report stands; with none yet, `undefined`: unchecked, so the
 * agent stays closed until its server answers, a few seconds after a deploy.
 */
function agentOwner(agent: Agent, now: number): Promise<AgentOwner | undefined> {
  const hit = reported.get(agent.name);
  if (hit && now - hit.at <= CACHE_MS) return Promise.resolve(hit.owner);
  const inFlight = reading.get(agent.name);
  if (inFlight) return inFlight;
  // Its own child not listening yet: unanswered, as when the server doesn't answer.
  let origin: string;
  try { origin = agentOrigin(agent); } catch { return Promise.resolve(hit?.owner); }
  // Marked as the gateway's own read, apart from the calls it forwards.
  const link = new RPCLink({ origin, url: "/rpc", headers: { "x-gateway": "owner-check" } });
  const client: RouterClient<Router> = createORPCClient(link);
  const read = client.ownerIdentity(undefined, { signal: AbortSignal.timeout(3_000) })
    .then(answer => {
      const parsed = identity.safeParse(answer);
      if (!parsed.success) { reported.delete(agent.name); return undefined; }
      const { owner } = parsed.data;
      reported.set(agent.name, { owner, at: now });
      return owner;
    }, () => hit?.owner)
    .finally(() => reading.delete(agent.name));
  reading.set(agent.name, read);
  return read;
}

/** Resolve only the requested agent; another agent's ownership lookup cannot block its calls. */
export async function resolveAgentAccess(account: string, agent: Agent, now = Date.now()): Promise<Access | null> {
  const owner = await ownerOf(agent.owner, now);
  const access = accessOf(account, owner);
  if (!access) return null;
  const reportedOwner = await agentOwner(agent, now);
  return reportedOwner !== undefined && ownedBy(reportedOwner, owner) ? access : null;
}

/** `account`'s access to each agent it may see, by agent name; empty when it may see none. */
export async function resolveAccess(account: string, agents: Agent[], now = Date.now()) {
  // Fleet discovery still resolves every configured agent concurrently.
  const granted = await Promise.all(agents.map(async agent => {
    const access = await resolveAgentAccess(account, agent, now);
    return access ? ([agent.name, access] as const) : null;
  }));
  return Object.fromEntries(granted.filter((g) => g !== null)) as Record<string, Access>;
}
