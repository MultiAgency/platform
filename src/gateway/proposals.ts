import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { Intent } from "@near-intents-agent-api/sdk";
import { decodeSignedDelegateAction, Near } from "near-kit";
import { mainnet } from "../chain.js";
import { nep413Hash } from "../nep413.js";
import { delegateSigningHash } from "../owner-signature.js";
import type { Router } from "../router.js";
import type { AgentEntry } from "./config.js";
import { type DaoProposal, signRequestOf } from "./sign-requests.js";
import type { Decoded, ProposalCheck as Check } from "../contract/proposals.js";
import { agentOrigin } from "./agent-origin.js";

/**
 * "What am I voting on?" A proposal asking `v1.signer` to sign shows members only a hash. Every owner
 * action this dashboard prepares is a hash of a known payload, so each pending proposal is matched
 * to the request an agent server is waiting on, and the hash recomputed from that payload: a member
 * sees the action in words, and that the hash really is that action's. A hash nothing here prepared
 * is flagged before anyone votes on it.
 */

/** The agents' owner key path (src/dao-owner.ts); Trezu signs its confidential payments on the DAO's own. */
const OWNER_PATH = "agent-owner";

/**
 * One request an agent server asked the DAO to sign (`owner.pending` there): still waiting for the
 * vote, done, or expired (the API's signing window closed first, so a signature can no longer be used).
 */
export type PendingOwnerIntent = {
  correlationId: string;
  type: string;
  expiresAt: string;
  hash: string;
  intent: Intent;
  delegate: string | null;
  state: "waiting" | "done" | "expired";
};

/**
 * A NEP-366 signed delegate action's sender, receiver and the methods it calls (read with
 * near-kit's codec), and the hash its signature covers: sha256 of the prefixed delegate action,
 * whose borsh bytes are everything before the 65-byte ed25519 signature (key type, then 64 bytes).
 */
export function readDelegate(signedDelegate: Uint8Array) {
  const { delegateAction } = decodeSignedDelegateAction(signedDelegate).signedDelegate;
  const methods = delegateAction.actions.map((action) => {
    if (!("functionCall" in action)) throw new Error("Not a function call");
    return action.functionCall.methodName;
  });
  return { sender: delegateAction.senderId, receiver: delegateAction.receiverId, methods, hash: delegateSigningHash(signedDelegate).toString("hex") };
}

/** Whether `request`'s hash really is the hash of its payload, and what that payload says. */
export function checkRequest(request: PendingOwnerIntent): Check {
  const { intent } = request;
  if (intent.standard === "nep413") {
    const { message, nonce, recipient } = intent.payload;
    const hash = nep413Hash(message, Buffer.from(nonce, "base64"), recipient).toString("hex");
    if (hash !== request.hash) return { kind: "mismatch", reason: "the payload hashes to something else" };
    let parsed: unknown = message;
    try {
      parsed = JSON.parse(message);
    } catch {}
    return { kind: "verified", standard: "nep413", message: parsed };
  }
  if (intent.standard === "nep366" && request.delegate) {
    const read = readDelegate(Buffer.from(request.delegate, "base64"));
    if (read.hash !== request.hash) return { kind: "mismatch", reason: "the delegate action hashes to something else" };
    const expected = intent.payload.actions.map((a) => a.params.methodName);
    if (read.receiver !== intent.payload.receiverId || read.methods.join() !== expected.join())
      return { kind: "mismatch", reason: "the delegate action calls something other than the API generated" };
    return { kind: "verified", standard: "nep366", receiver: read.receiver, methods: read.methods };
  }
  return { kind: "mismatch", reason: `nothing to check a ${intent.standard} request against` };
}

export type { Decoded } from "../contract/proposals.js";

/**
 * Every `v1.signer` proposal among `proposals`, newest first, matched against what the agents wait for.
 * An agent's requests are `null` when it didn't answer: that is no evidence it prepared nothing.
 */
export function decodeProposals(dao: string, proposals: DaoProposal[], requests: Record<string, PendingOwnerIntent[] | null>): Decoded[] {
  const byHash = new Map(Object.entries(requests).flatMap(([agent, list]) => (list ?? []).map((r) => [r.hash.toLowerCase(), { agent, request: r }] as const)));
  const unanswered = Object.keys(requests).filter((agent) => requests[agent] === null);
  return proposals
    .flatMap((p): Decoded[] => {
      const sign = signRequestOf(p);
      if (!sign) return [];
      const base = {
        id: p.id,
        proposer: p.proposer,
        description: p.description,
        status: p.status,
        submittedAt: new Date(Number(BigInt(p.submission_time) / 1_000_000n)).toISOString(),
        votes: p.votes,
        hash: sign.hash,
      };
      if (sign.path === dao) return [{ ...base, what: "trezu" as const }];
      if (sign.path !== OWNER_PATH || sign.domainId !== 1) return [{ ...base, what: "other" as const, path: sign.path }];
      const match = byHash.get(sign.hash);
      if (!match) {
        if (p.status !== "InProgress") return [{ ...base, what: "past" as const }];
        return [unanswered.length ? { ...base, what: "unchecked" as const, unanswered } : { ...base, what: "unknown" as const }];
      }
      const { correlationId, type, expiresAt, state } = match.request;
      return [{ ...base, what: "agent" as const, agent: match.agent, type, correlationId, expiresAt, state, check: checkRequest(match.request) }];
    })
    .sort((a, b) => b.id - a.id);
}

const near = new Near(mainnet);

/** What an agent server waits for the DAO to sign, read over loopback; null if it doesn't answer. */
async function agentRequests(agent: AgentEntry): Promise<PendingOwnerIntent[] | null> {
  let origin: string;
  try { origin = agentOrigin(agent); } catch { return null; }
  const client: RouterClient<Router> = createORPCClient(new RPCLink({ origin, url: "/rpc" }));
  // The server's `state` is a plain string in its type; it only ever holds PendingOwnerIntent's three.
  return client.owner.pending(undefined, { signal: AbortSignal.timeout(10_000) }).then((r) => r as PendingOwnerIntent[], () => null);
}

/** The DAO's latest `limit` proposals that ask v1.signer to sign, decoded against every agent. */
export async function recentSignProposals(dao: string, agents: AgentEntry[], limit = 30) {
  const last = (await near.view<number>(dao, "get_last_proposal_id")) ?? 0;
  const [proposals, ...requests] = await Promise.all([
    last ? near.view<DaoProposal[]>(dao, "get_proposals", { from_index: Math.max(0, last - limit), limit }) : [],
    ...agents.map(agentRequests),
  ]);
  return decodeProposals(dao, proposals ?? [], Object.fromEntries(agents.map((a, i) => [a.name, requests[i] ?? null])));
}
