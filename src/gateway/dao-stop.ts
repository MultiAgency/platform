import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { proposalTransaction } from "../dao-owner.js";
import { sendJson as json } from "../http.js";
import { nep413Hash, verifyEd25519 } from "../nep413.js";
import type { Router } from "../router.js";
import { appendSynced } from "../synced.js";
import { AppConsents, UNBORN } from "./app-access.js";
import { chainDaoVotes, checkUrl, daoStopText, DaoRequests, type DaoStopRequest, type DaoVotes, escape, page, PAGE_HEADERS, row } from "./app-dao.js";
import { agentOrigin } from "./agent-origin.js";
import type { AgentEntry } from "./config.js";
import { AuthorityUnanswered, chainDaoOwner, type DaoOwnerReads, resolveDaoAuthority } from "./machine-authority.js";

const STOP_MS = 7 * 86_400_000;

/**
 * A DAO's own stop of its agent, with no app involved (coordination/p5-treasury-dao-consent.md, slice 6). Opening
 * `/confirm/dao/stop/<agent>` files a stop for the DAO to vote on, or shows the one open; once the vote has passed,
 * opening it again applies it: every consent naming the agent ID is revoked, and the agent's autopilot turned off. It
 * only removes authority. Anyone may open it; only the DAO's signature over the exact text has an effect.
 */
export async function daoStopRoutes(req: IncomingMessage, res: ServerResponse, pathname: string, host: string, root: string,
  selected: AgentEntry[], stopping: () => boolean, options: { daoOwner?: DaoOwnerReads; daoVotes?: DaoVotes; stopAutopilot?: (agent: AgentEntry, dao: string) => Promise<void> } = {}): Promise<boolean> {
  const match = pathname.match(/^\/confirm\/dao\/stop\/([a-z0-9-]{1,32})$/);
  if (!match) return false;
  if (!["GET", "HEAD"].includes(req.method ?? "")) { json(res, 405, { error: "Use GET" }); return true; }
  const daoOwner = options.daoOwner ?? chainDaoOwner, daoVotes = options.daoVotes ?? chainDaoVotes, stopAutopilot = options.stopAutopilot ?? agentAutopilotOff;
  const send = (status: number, body: string) => { res.writeHead(status, PAGE_HEADERS); res.end(req.method === "HEAD" ? undefined : page("Stop a DAO's agent", body)); return true; };
  const name = match[1]!, lowered = host.toLowerCase();
  const agent = selected.find(a => a.name === name);
  let authority: Awaited<ReturnType<typeof resolveDaoAuthority>>;
  try { authority = agent ? await resolveDaoAuthority(agent, daoOwner) : null; }
  catch (error) {
    if (!(error instanceof AuthorityUnanswered)) throw error;
    return send(503, "<h1>The agent's ownership couldn't be checked now</h1><p>Nothing changed. Open this page again.</p>");
  }
  if (!agent || !authority || authority.agentId === null) return send(404, "<h1>No such DAO-owned agent here</h1><p>Only a created agent owned by a Sputnik DAO can be stopped from this page.</p>");
  const requests = new DaoRequests(root), now = Date.now();
  const [latest] = requests.stops(name, lowered);

  // The open stop: applied once the DAO's signature is found, within its window (or recorded already).
  let shown: DaoStopRequest | undefined = latest;
  if (latest && !latest.done?.autopilotOff && (latest.signature || now < latest.votingUntil)) {
    let signature: Buffer | null = latest.signature ? Buffer.from(latest.signature, "base64") : null;
    if (!signature) {
      let found: Buffer | null = null;
      try { found = await daoVotes.findSignature(latest.dao, { owner: latest.signer, hash: latest.id, since: latest.since }); }
      catch { return send(503, "<h1>The DAO's proposals couldn't be read now</h1><p>Nothing changed. Open this page again.</p>"); }
      let verified = false;
      try { verified = !!found && verifyEd25519(latest.signer.public_key, Buffer.from(latest.id, "hex"), found); } catch { verified = false; }
      if (verified) { requests.signed(latest.id, found!); signature = found; }
    }
    if (signature) {
      if (stopping()) return send(503, "<h1>The platform is restarting</h1><p>Nothing was applied yet. Open this page again.</p>");
      shown = await apply(root, requests, new AppConsents(root), latest, agent, authority.agentId, stopAutopilot, now);
    }
  } else if (!latest || latest.done?.autopilotOff || now >= latest.votingUntil) {
    // None open: file one. Only the DAO's vote over its exact text gives it any effect.
    if (stopping()) return send(503, "<h1>The platform is restarting</h1><p>Nothing was filed. Open this page again.</p>");
    let since: number;
    try { since = await daoVotes.latestBlock(); } catch { return send(503, "<h1>The chain couldn't be read now</h1><p>Nothing was filed. Open this page again.</p>"); }
    const message = daoStopText({ host: lowered, dao: agent.owner, agent: name, agentId: authority.agentId });
    const nonce = randomBytes(32), id = nep413Hash(message, nonce, lowered).toString("hex");
    const filed = requests.fileStop({ id, host: lowered, dao: agent.owner, agent: name, agentId: authority.agentId, expiresAt: now + STOP_MS,
      createdAt: now, message, nonce: nonce.toString("base64"), signer: { account_id: authority.signer.account_id, public_key: authority.signer.public_key }, since }, now);
    appendSynced(join(root, "access.jsonl"), { at: new Date(now).toISOString(), event: "dao-stop-filed", request: id, owner: agent.owner, agent: name });
    return send(200, filedPage(filed, proposalTransaction(agent.owner, id, filed.description, authority.policy.proposal_bond), latest));
  }
  return send(200, shown!.done ? donePage(shown!) : filedPage(shown!, proposalTransaction(agent.owner, shown!.id, shown!.description, authority.policy.proposal_bond)));
}

/** Revokes every consent naming the agent ID (and its setup consents), then turns the agent's autopilot off. */
async function apply(root: string, requests: DaoRequests, consents: AppConsents, record: DaoStopRequest, agent: AgentEntry, current: string,
  stopAutopilot: (agent: AgentEntry, dao: string) => Promise<void>, now: number) {
  const revoked = record.done?.revoked ?? [];
  for (const consent of consents.list({}).filter(c => c.host === record.host && c.agent === record.agent && (c.agentId === record.agentId || c.agentId === UNBORN) && !c.revoked)) {
    consents.revoke(consent.id, null, now, "dao-stop");
    revoked.push(consent.id);
  }
  // A replaced agent isn't the one the DAO voted to stop: there is nothing of it left to turn off.
  let autopilotOff = current !== record.agentId;
  if (!autopilotOff) try { await stopAutopilot(agent, record.dao); autopilotOff = true; } catch { autopilotOff = false; }
  const done = requests.stopped(record.id, { at: now, revoked, autopilotOff });
  appendSynced(join(root, "access.jsonl"), { at: new Date(now).toISOString(), event: "dao-stop", request: record.id, owner: record.dao, agent: record.agent, revoked, autopilotOff });
  return done;
}

/** The agent's own `autopilot/stop`, called by the gateway for the DAO. */
async function agentAutopilotOff(agent: AgentEntry, dao: string) {
  const client: RouterClient<Router> = createORPCClient(new RPCLink({ origin: agentOrigin(agent), url: "/rpc", headers: { "x-gateway-actor": `dao:${dao}` } }));
  await client.autopilot.stop(undefined, { signal: AbortSignal.timeout(5_000) });
}

function filedPage(record: DaoStopRequest, transaction: ReturnType<typeof proposalTransaction>, previous?: DaoStopRequest) {
  const call = { request: { path: "agent-owner", payload_v2: { Eddsa: record.id }, domain_id: 1 } };
  return `<h1>Stop this DAO's agent</h1>
<table>${row("DAO", record.dao)}${row("Agent", `${record.agent} (${record.agentId})`)}${row("State", record.signature ? "signed; applying" : `waiting for the DAO's vote until ${new Date(record.votingUntil).toISOString()}`)}</table>
${previous?.done ? `<p>An earlier stop was applied at ${escape(new Date(previous.done.at).toISOString())}. This is a new request.</p>` : ""}
<p>Once the DAO's proposal below passes, open this page again: the platform then ends every app consent for this agent and turns its autopilot off. Nothing happens before the vote.</p>
<h2>The exact text the DAO signs</h2><pre>${escape(record.message)}</pre>
<p>Hash <code>${escape(record.id)}</code>, checked at <code>${escape(checkUrl(record))}</code>.</p>
<h2>File it</h2>
<p>A member who may propose files a function-call proposal on the DAO, for example in Trezu: contract <code>v1.signer</code>, method <code>sign</code>, deposit 1 yoctoNEAR, gas 50 TGas, arguments:</p>
<pre>${escape(JSON.stringify(call, null, 2))}</pre>
<p>Or the whole transaction, signed by a member's wallet (it attaches the DAO's proposal bond):</p>
<pre>${escape(JSON.stringify(transaction, null, 2))}</pre>`;
}

function donePage(record: DaoStopRequest) {
  return `<h1>This DAO's agent was stopped</h1>
<table>${row("DAO", record.dao)}${row("Agent", `${record.agent} (${record.agentId})`)}${row("Applied", new Date(record.done!.at).toISOString())}${row("Consents revoked", String(record.done!.revoked.length))}${row("Autopilot", record.done!.autopilotOff ? "off" : "not confirmed off: open this page again")}</table>
<p>An app reaches this agent again only under a new consent. Swaps a tick had already started go through the platform's guarded send path as always.</p>`;
}
