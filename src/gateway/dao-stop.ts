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
import { clientAddress, hourlyLimit } from "../signin.js";
import { appendSynced } from "../synced.js";
import { AppConsents, UNBORN } from "./app-access.js";
import { chainDaoVotes, checkUrl, daoStopText, DaoRequests, type DaoStopRequest, type DaoVotes, escape, page, PAGE_HEADERS, row } from "./app-dao.js";
import { agentOrigin } from "./agent-origin.js";
import type { AgentEntry } from "./config.js";
import { AuthorityUnanswered, chainDaoOwner, type DaoOwnerReads, resolveDaoAuthority } from "./machine-authority.js";

const STOP_MS = 7 * 86_400_000;
/**
 * Opens of one agent's stop page an hour from one address: a member opens it a few times per stop, and each open reads
 * the chain. Counted per address, so no one can keep the page closed to the DAO's members.
 */
const mayOpen = hourlyLimit(60);
/** One open at a time per agent, so a stop is filed, found and applied once, and its record counts each consent once. */
const locks = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).then(work, work);
  const tail = run.then(() => undefined, () => undefined);
  locks.set(key, tail);
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

/**
 * A DAO's own stop of its agent, with no app involved (coordination/p5-treasury-dao-consent.md, slice 6). Opening
 * `/confirm/dao/stop/<dao>/<agent>` files a stop for the DAO to vote on, or shows the one open; once the vote has passed,
 * opening it again applies it: every app consent for the agent given before it is applied is revoked, every consent
 * request filed before then is ended, and the agent's autopilot turned off. It only removes authority. Anyone may open it; only the
 * DAO's signature over the exact text has an effect. The page names the DAO, so nothing is read for a pair that isn't
 * configured here, and it doesn't tell which agents a DAO owns to anyone who doesn't already know.
 */
export async function daoStopRoutes(req: IncomingMessage, res: ServerResponse, pathname: string, host: string, root: string,
  selected: AgentEntry[], stopping: () => boolean, options: { daoOwner?: DaoOwnerReads; daoVotes?: DaoVotes; stopAutopilot?: (agent: AgentEntry, dao: string) => Promise<void>;
    mayOpen?: (key: string) => boolean } = {}): Promise<boolean> {
  const match = pathname.match(/^\/confirm\/dao\/stop\/([a-z0-9._-]{2,64})\/([a-z0-9-]{1,32})$/);
  if (!match) return false;
  // Opening files a stop, so it is a GET a member makes, never a HEAD or a form.
  if (req.method !== "GET") { json(res, 405, { error: "Use GET" }); return true; }
  const send = (status: number, body: string) => { res.writeHead(status, PAGE_HEADERS); res.end(page("Stop a DAO's agent", body)); return true; };
  const dao = match[1]!, name = match[2]!;
  const agent = selected.find(a => a.name === name && a.owner === dao);
  if (!agent) return send(404, "<h1>No such DAO-owned agent here</h1><p>Only a created agent owned by a Sputnik DAO can be stopped from this page.</p>");
  if (!(options.mayOpen ?? mayOpen)(`${clientAddress(req)}/${dao}/${name}`)) return send(429, "<h1>This page was opened too often</h1><p>Nothing changed. Open it again within the hour.</p>");
  return serialized(`${host.toLowerCase()}/${name}`, () => openStop(send, host.toLowerCase(), root, agent, stopping, {
    daoOwner: options.daoOwner ?? chainDaoOwner, daoVotes: options.daoVotes ?? chainDaoVotes, stopAutopilot: options.stopAutopilot ?? agentAutopilotOff }));
}

async function openStop(send: (status: number, body: string) => boolean, host: string, root: string, agent: AgentEntry, stopping: () => boolean,
  { daoOwner, daoVotes, stopAutopilot }: { daoOwner: DaoOwnerReads; daoVotes: DaoVotes; stopAutopilot: (agent: AgentEntry, dao: string) => Promise<void> }) {
  let authority: Awaited<ReturnType<typeof resolveDaoAuthority>>;
  try { authority = await resolveDaoAuthority(agent, daoOwner); }
  catch (error) {
    if (!(error instanceof AuthorityUnanswered)) throw error;
    return send(503, "<h1>The agent's ownership couldn't be checked now</h1><p>Nothing changed. Open this page again.</p>");
  }
  if (!authority || authority.agentId === null) return send(404, "<h1>No such DAO-owned agent here</h1><p>Only a created agent owned by a Sputnik DAO can be stopped from this page.</p>");
  const requests = new DaoRequests(root), now = Date.now();
  const filedPageOf = (record: DaoStopRequest, previous?: DaoStopRequest) =>
    filedPage(record, proposalTransaction(agent.owner, record.id, record.description, authority.policy.proposal_bond), previous);
  let [latest] = requests.stops(agent.name, host);

  // The open stop: applied once the DAO's signature is found. A vote that passed is honoured whenever the page is next
  // opened: after its window the signature is looked for once more, and only then is the stop lapsed.
  if (latest && !latest.done?.autopilotOff && !latest.lapsed) {
    let signature: Buffer | null = latest.signature ? Buffer.from(latest.signature, "base64") : null;
    if (!signature) {
      let found: Buffer | null = null;
      try { found = await daoVotes.findSignature(latest.dao, { owner: latest.signer, hash: latest.id, since: latest.since }); }
      catch { return send(503, "<h1>The DAO's proposals couldn't be read now</h1><p>Nothing changed. Open this page again.</p>"); }
      let verified = false;
      try { verified = !!found && verifyEd25519(latest.signer.public_key, Buffer.from(latest.id, "hex"), found); } catch { verified = false; }
      if (verified) { latest = requests.signed(latest.id, found!) as DaoStopRequest; signature = found; }
    }
    if (signature) {
      if (stopping()) return send(503, "<h1>The platform is restarting</h1><p>Nothing was applied yet. Open this page again.</p>");
      const done = await apply(root, requests, new AppConsents(root), latest, agent, authority.agentId, stopAutopilot, now);
      return send(200, donePage(done));
    }
    if (now < latest.votingUntil) return send(200, filedPageOf(latest));
    requests.lapse(latest.id);
  }

  // None open: file one. Only the DAO's vote over its exact text gives it any effect.
  if (stopping()) return send(503, "<h1>The platform is restarting</h1><p>Nothing was filed. Open this page again.</p>");
  let since: number;
  try { since = await daoVotes.latestBlock(); } catch { return send(503, "<h1>The chain couldn't be read now</h1><p>Nothing was filed. Open this page again.</p>"); }
  const message = daoStopText({ host, dao: agent.owner, agent: agent.name, agentId: authority.agentId });
  const nonce = randomBytes(32), id = nep413Hash(message, nonce, host).toString("hex");
  const filed = requests.fileStop({ id, host, dao: agent.owner, agent: agent.name, agentId: authority.agentId, expiresAt: now + STOP_MS,
    createdAt: now, message, nonce: nonce.toString("base64"), signer: { account_id: authority.signer.account_id, public_key: authority.signer.public_key }, since }, now);
  appendSynced(join(root, "access.jsonl"), { at: new Date(now).toISOString(), event: "dao-stop-filed", request: id, owner: agent.owner, agent: agent.name });
  return send(200, filedPageOf(filed, latest));
}

/**
 * Ends everything given for the agent before the stop is first applied (`done.at`, its cutoff), then turns the agent's
 * autopilot off: every app consent, and every consent request filed by then. The cutoff and what it revokes are recorded
 * before revoking, so a crash between leaves both on record. Applied again until autopilot is confirmed off, it keeps
 * its first cutoff: consents the DAO gives after the stop was applied are its later choice and stay live.
 */
async function apply(root: string, requests: DaoRequests, consents: AppConsents, record: DaoStopRequest, agent: AgentEntry, current: string,
  stopAutopilot: (agent: AgentEntry, dao: string) => Promise<void>, now: number) {
  const cutoff = record.done?.at ?? now;
  requests.endFiledBefore(record, cutoff);
  const ending = consents.list({}).filter(c => c.host === record.host && c.agent === record.agent && !c.revoked &&
    (c.agentId === record.agentId || c.agentId === UNBORN) && c.createdAt <= cutoff).map(c => c.id);
  const revoked = [...new Set([...record.done?.revoked ?? [], ...ending])];
  requests.stopped(record.id, { at: cutoff, revoked, autopilotOff: false });
  for (const id of ending) consents.revoke(id, null, now, "dao-stop");
  // A replaced agent isn't the one the DAO voted to stop: there is nothing of it left to turn off.
  let autopilotOff = current !== record.agentId;
  if (!autopilotOff) try { await stopAutopilot(agent, record.dao); autopilotOff = true; } catch { autopilotOff = false; }
  const done = requests.stopped(record.id, { at: cutoff, revoked, autopilotOff });
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
<table>${row("DAO", record.dao)}${row("Agent", `${record.agent} (${record.agentId})`)}${row("State", `waiting for the DAO's vote until ${new Date(record.votingUntil).toISOString()}`)}</table>
${previous?.done ? `<p>An earlier stop was applied at ${escape(new Date(previous.done.at).toISOString())}. This is a new request.</p>` : ""}
<p>Once the DAO's proposal below passes, open this page again: the platform then ends every app consent for this agent given before it applies the stop, and turns its autopilot off. Nothing happens before the vote, or before the page is opened after it.</p>
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
<p>Every app consent given before the stop was applied has ended. An app reaches this agent again only under a consent the DAO votes after that, and the DAO's Treasury grant still stands: such an app may turn autopilot on again. A tick already started, and an app's call already forwarded, finish through the platform's guarded send path as always. Owner actions already waiting for the DAO's vote (a grant, a freeze) still take effect if that vote passes.</p>`;
}
