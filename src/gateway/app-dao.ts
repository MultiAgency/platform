import { createHash } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DAO_CONSENT_SCOPES, DAO_SETUP_AREAS } from "../contract/app-access.js";
import { AppScope, parseConsentMessage, parseSetupMessage, UNBORN_AGENT } from "../contract/app-consent.js";
import { MAX_PROPOSAL_MS } from "../contract/treasury-proposals.js";
import { nextProposalId } from "../chain.js";
import { findSignature, latestBlock } from "../dao-owner.js";
import { BadRequest } from "../http.js";
import { nep413Hash } from "../nep413.js";
import { writeAtomic } from "../synced.js";
import { MAX_CONSENT_DAYS, privateDirectory, readRecord, type VerifiedConsent } from "./app-access.js";

/**
 * DAO consent (coordination/p5-treasury-dao-consent.md, slice 1): a DAO owner consents by its own vote. The app files the
 * canonical consent text; the platform picks the NEP-413 nonce, records the request, and answers the proposal a member
 * files. Once a proposal calling `v1.signer` passes, the DAO's signature over the hash is found on chain and the consent is
 * stored as signed by the DAO's derived key. Nothing here sends money or holds a key.
 */

const DAY = 86_400_000;
const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
/** Requests per deployment still waiting for a vote; another is refused until one passes or lapses. */
export const MAX_PENDING_DAO_REQUESTS = 64;
/** Requests a deployment may file in a day, whatever their windows: bounds the records a credential can make. */
export const MAX_DAO_REQUESTS_PER_DAY = 256;
/** How long a finished request (completed, stopped, lapsed or expired) is kept before it is removed. */
export const DAO_REQUEST_RETENTION_MS = 30 * DAY;

const common = {
  version: z.literal(1),
  /** The NEP-413 hash (hex) the DAO's key signs: unique, since the platform picked the nonce. */
  id: hex64, deployment: z.string(), host: z.string(), organization: z.string(), dao: z.string(), agent: z.string(), agentId: z.string(),
  expiresAt: z.number().int().positive(), votingUntil: z.number().int().positive(), createdAt: z.number().int().nonnegative(),
  message: z.string(), nonce: z.string(), signer: z.strictObject({ account_id: z.string(), public_key: z.string() }),
  /** The block height read before filing: no proposal can have signed this hash earlier. */
  since: z.number().int().nonnegative(), description: z.string(),
  /** The DAO's signature (base64), recorded once found and verified, before it's acted on: a later read completes from it. */
  signature: z.string().nullable().optional(),
};
const ConsentRequest = z.strictObject({ ...common, kind: z.literal("consent"), scopes: z.array(AppScope),
  /** The stored consent's id once the signature was found. */
  consent: hex64.nullable(),
  /** The DAO stop applied after this request was filed, which ended it: it is never stored, whatever its vote. */
  stoppedBy: hex64.nullable().optional() });
/** A vote on a Treasury proposal, under the DAO consent `under`; `relayed` once the signature reached the agent. */
const VoteRequest = z.strictObject({ ...common, kind: z.literal("proposal"), proposal: z.string(), verdict: z.enum(["approve", "reject"]),
  under: hex64, relayed: z.strictObject({ at: z.number().int(), state: z.string() }).nullable() });
/** A DAO's setup of a hosted agent; `consent` and `agent` once the signature was found and the agent reserved. */
const SetupRequest = z.strictObject({ ...common, kind: z.literal("setup"), area: z.enum(DAO_SETUP_AREAS),
  consent: hex64.nullable(), reserved: z.string().nullable() });
/**
 * A DAO's stop of its agent, filed by anyone and done only by the DAO's vote: every app consent and consent request
 * given before it is first applied (`done.at`) is ended, and the agent's autopilot turned off. No app or deployment is involved (`deployment` and
 * `organization` are empty). `lapsed`: its window closed and no signature was found then, so a new one may be filed.
 */
const StopRequest = z.strictObject({ ...common, kind: z.literal("stop"),
  done: z.strictObject({ at: z.number().int(), revoked: z.array(hex64), autopilotOff: z.boolean() }).nullable(),
  lapsed: z.boolean().optional() });
const Request = z.discriminatedUnion("kind", [ConsentRequest, VoteRequest, SetupRequest, StopRequest]);
export type DaoRequest = z.infer<typeof Request>;
export type DaoConsentRequest = z.infer<typeof ConsentRequest>;
export type DaoVoteRequest = z.infer<typeof VoteRequest>;
export type DaoSetupRequest = z.infer<typeof SetupRequest>;
export type DaoStopRequest = z.infer<typeof StopRequest>;
const settled = (r: DaoRequest) => r.kind === "proposal" ? r.relayed !== null : r.kind === "stop" ? r.done?.autopilotOff === true || r.lapsed === true
  : r.consent !== null || (r.kind === "consent" && !!r.stoppedBy);
/**
 * Nothing more can happen to it: completed, stopped, lapsed, or its window or text expired with no signature. A stop is
 * finished only once applied or lapsed: a vote that passed is honoured whenever its page is next opened.
 */
const finished = (r: DaoRequest, now: number) => settled(r) || (r.kind !== "stop" && ((!r.signature && now >= r.votingUntil) || now >= r.expiresAt));
export const publicDaoRequest = ({ id, dao, organization, agent, agentId, scopes, expiresAt, votingUntil, description }: DaoConsentRequest) =>
  ({ id, dao, organization, agent, agentId, scopes, expiresAt, votingUntil, hash: id, description });
export const publicDaoSetup = ({ id, dao, organization, area, expiresAt, votingUntil, description }: DaoSetupRequest) =>
  ({ id, dao, organization, area, expiresAt, votingUntil, hash: id, description });
export const publicDaoVote = ({ id, dao, organization, agent, agentId, proposal, verdict, votingUntil, description }: DaoVoteRequest) =>
  ({ id, dao, organization, agent, agentId, proposal, verdict, votingUntil, hash: id, description });

/** The chain reads a DAO vote needs; tests pass their own. */
export type DaoVotes = {
  latestBlock: () => Promise<number>;
  nextProposalId: (dao: string) => Promise<number | null>;
  findSignature: (dao: string, signing: { owner: DaoRequest["signer"]; hash: string; since: number }) => Promise<Buffer | null>;
};
export const chainDaoVotes: DaoVotes = {
  latestBlock, nextProposalId,
  findSignature: (dao, { owner, hash, since }) => findSignature(dao, { owner: { type: "near", ...owner }, intent: undefined as never, hash, since }),
};

/**
 * A consent text a DAO may vote on: canonical, for this host and the calling deployment, expiring between a minute and
 * `MAX_CONSENT_DAYS` from now, and with scopes within `DAO_CONSENT_SCOPES`. Throws a BadRequest saying why.
 */
export function verifyDaoConsentText(message: string, expected: { host: string; deployment: string }, now = Date.now()) {
  const text = parseConsentMessage(message);
  if (!text) throw new BadRequest("The consent text isn't a canonical app consent.");
  if (text.host !== expected.host.toLowerCase()) throw new BadRequest("The consent names another platform host.");
  if (text.deployment !== expected.deployment) throw new BadRequest("The consent names another app deployment.");
  const expiresAt = Date.parse(text.expiresAt);
  if (expiresAt <= now + 60_000) throw new BadRequest("The consent has expired or expires within a minute.");
  if (expiresAt > now + MAX_CONSENT_DAYS * DAY) throw new BadRequest(`A consent lasts at most ${MAX_CONSENT_DAYS} days.`);
  const allowed = new Set<string>(DAO_CONSENT_SCOPES);
  const other = text.scopes.filter(scope => !allowed.has(scope));
  if (other.length) throw new BadRequest(`A DAO's consent carries only ${DAO_CONSENT_SCOPES.join(" and ")}, not ${other.join(", ")}.`);
  return { text, expiresAt };
}

/**
 * A setup text a DAO may vote on: canonical, for this host and the calling deployment, an area within `DAO_SETUP_AREAS`,
 * and expiring between a minute and Sputnik's default proposal period from now (a vote takes longer than a wallet's
 * hour). Throws a BadRequest saying why.
 */
export function verifyDaoSetupText(message: string, expected: { host: string; deployment: string }, now = Date.now()) {
  const text = parseSetupMessage(message);
  if (!text) throw new BadRequest("The setup text isn't a canonical app setup.");
  if (text.host !== expected.host.toLowerCase()) throw new BadRequest("The setup names another platform host.");
  if (text.deployment !== expected.deployment) throw new BadRequest("The setup names another app deployment.");
  const expiresAt = Date.parse(text.expiresAt);
  if (expiresAt <= now + 60_000) throw new BadRequest("The setup has expired or expires within a minute.");
  if (expiresAt > now + MAX_PROPOSAL_MS) throw new BadRequest("A DAO's setup lasts at most 7 days.");
  if (!(DAO_SETUP_AREAS as readonly string[]).includes(text.area)) throw new BadRequest(`A DAO sets up only ${DAO_SETUP_AREAS.join(", ")} agents through an app.`);
  return { text: { ...text, area: text.area as (typeof DAO_SETUP_AREAS)[number] }, expiresAt };
}

/** What the DAO's proposal says for a setup: which app, Organization and area, and that creating the agent is a second vote. */
export function daoSetupDescription(request: Pick<DaoSetupRequest, "deployment" | "organization" | "area" | "expiresAt" | "votingUntil" | "id" | "host">) {
  return [
    `* Proposal Action: Setup: app deployment ${request.deployment} may set up a hosted ${request.area} agent owned by this DAO for ` +
      `Organization ${request.organization}, and ask the DAO to create it, until ${new Date(request.expiresAt).toISOString()}`,
    `* Signing window closes: ${new Date(request.votingUntil).toISOString()} (approve before then, or nothing is set up)`,
    `* Signs: NEP-413 hash ${request.id} for ${request.host} as the agents' owner (v1.signer, path agent-owner)`,
    `* Check before voting: ${checkUrl(request)} (the exact text, and its hash recomputed)`,
    "* Notes: Filed by the MultiAgency platform for an app. Creating the agent is a separate vote, which must pass within minutes.",
  ].join(" <br>");
}

/** The setup consent a found signature completes: `owner` scope for the reserved agent, only while it isn't created. */
export function daoSetupConsent(request: DaoSetupRequest, signature: Buffer, agent: string): VerifiedConsent {
  return { version: 1, id: createHash("sha256").update(signature.toString("hex")).digest("hex"), deployment: request.deployment,
    host: request.host, organization: request.organization, owner: request.dao, agent, agentId: UNBORN_AGENT, scopes: ["owner"],
    expiresAt: request.expiresAt, message: request.message, nonce: request.nonce, publicKey: request.signer.public_key,
    signature: signature.toString("base64"), signer: "dao" };
}

/** The platform's public page for a DAO request: what its key signs, for members to check before voting. */
export const checkUrl = ({ host, id }: { host: string; id: string }) => `https://${host}/confirm/dao/${id}`;

export const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const KINDS = { consent: "Consent for an app", setup: "Setup of a hosted agent", proposal: "Vote on a Treasury proposal", stop: "Stop of the agent" } as const;

/**
 * The voter check view (coordination/p5-treasury-dao-consent.md, slice 4): the exact text a DAO request's key signs,
 * its nonce and host, and whether its NEP-413 hash, recomputed here now, is the hash the request names. Plain HTML,
 * every value escaped, no script. A member compares the hash with the `v1.signer` call's `payload_v2` in the proposal.
 */
export function daoRequestPage(record: DaoRequest, now = Date.now()) {
  const recomputed = nep413Hash(record.message, Buffer.from(record.nonce, "base64"), record.host).toString("hex") === record.id;
  const state = record.kind === "proposal" ? (record.relayed ? `relayed to the agent (the proposal was ${record.relayed.state})` : null)
    : record.kind === "stop" ? (record.done ? `stopped: ${record.done.revoked.length} consent(s) revoked, autopilot ${record.done.autopilotOff ? "off" : "not yet confirmed off"}` : null)
    : record.consent ? (record.kind === "setup" ? `the agent ${record.reserved} was reserved` : "the consent was stored")
    : record.kind === "consent" && record.stoppedBy ? "ended by the DAO's stop of the agent; it is never stored" : null;
  const signed = record.kind === "stop" ? "signed; applied when the stop page is next opened"
    : now >= record.expiresAt ? "signed, but its text has expired; nothing more is done"
    : `signed; completed when the app next reads it, until ${new Date(record.expiresAt).toISOString()}`;
  const status = state ?? (record.signature ? signed
    : record.kind === "stop" && !record.lapsed && now >= record.votingUntil ? "the vote window closed; the stop page looks once more for a passed vote when next opened"
    : now >= record.votingUntil ? "the vote window closed with no signature found; nothing was done"
    : `waiting for the vote until ${new Date(record.votingUntil).toISOString()}`);
  return page("DAO vote check", `<h1>What this DAO vote signs</h1>
<table>${row("Request", KINDS[record.kind])}${row("DAO", record.dao)}${record.deployment ? row("App deployment", record.deployment) : ""}${record.organization ? row("Organization", record.organization) : ""}${record.agent ? row("Agent", `${record.agent} (${record.agentId})`) : ""}${row("State", status)}</table>
<h2>The exact text</h2><p>Signed with NEP-413 for recipient <code>${escape(record.host)}</code>, nonce <code>${escape(record.nonce)}</code>.</p>
<pre>${escape(record.message)}</pre>
<h2>The hash</h2><p><code>${escape(record.id)}</code></p>
<p class="${recomputed ? "ok" : "bad"}">${recomputed ? "Recomputed here from the text, nonce and host: it matches." : "Recomputed here from the text, nonce and host: it does not match. Don't vote for it."}</p>
<p>Before voting, check that the proposal's <code>v1.signer</code> call signs exactly this hash (<code>payload_v2.Eddsa</code>). A proposal that signs any other hash isn't this request, whatever its description says.</p>`);
}

export const row = (label: string, value: string) => `<tr><th>${escape(label)}</th><td>${escape(value)}</td></tr>`;
/** A plain page: no script, the caller's markup with every value already escaped. */
export const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fff}
pre,code{font:13px/1.45 ui-monospace,monospace;white-space:pre-wrap;word-break:break-all}pre{background:#f4f4f5;padding:.75rem;border-radius:6px}
th{text-align:left;padding-right:1rem;vertical-align:top}.ok{color:#166534}.bad{color:#b91c1c;font-weight:600}
@media (prefers-color-scheme:dark){body{color:#eee;background:#111}pre{background:#222}.ok{color:#4ade80}.bad{color:#f87171}}</style></head><body>
${body}
</body></html>`;
/** The headers every public DAO page is served with: no script, no framing, never cached. */
export const PAGE_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" } as const;

/** What the DAO's proposal says: the consent's terms, the vote's deadline, and the hash its key signs. */
export function daoConsentDescription(request: Pick<DaoConsentRequest, "deployment" | "organization" | "agent" | "agentId" | "scopes" | "expiresAt" | "votingUntil" | "id" | "host">) {
  return [
    `* Proposal Action: Consent: app deployment ${request.deployment} may act for Organization ${request.organization} on agent ` +
      `${request.agent} (${request.agentId}) with ${[...request.scopes].sort().join(", ")} until ${new Date(request.expiresAt).toISOString()}`,
    `* Signing window closes: ${new Date(request.votingUntil).toISOString()} (approve before then, or the consent isn't stored)`,
    `* Signs: NEP-413 hash ${request.id} for ${request.host} as the agents' owner (v1.signer, path agent-owner)`,
    `* Check before voting: ${checkUrl(request)} (the exact text, and its hash recomputed)`,
    "* Notes: Filed by the MultiAgency platform for an app. The signature gives the app only these scopes; it can't sign for the DAO.",
  ].join(" <br>");
}

/** What the DAO's proposal says for a Treasury proposal vote: the platform's own text of its terms, verbatim. */
export function daoVoteDescription(request: Pick<DaoVoteRequest, "message" | "votingUntil" | "id" | "host">) {
  return [
    ...request.message.split("\n").map((line, i) => i === 0 ? `* Proposal Action: ${line}` : `* ${line}`),
    `* Signing window closes: ${new Date(request.votingUntil).toISOString()} (approve before then, or the vote isn't relayed)`,
    `* Signs: NEP-413 hash ${request.id} for ${request.host} as the agents' owner (v1.signer, path agent-owner)`,
    `* Check before voting: ${checkUrl(request)} (the exact text, and its hash recomputed)`,
    "* Notes: Filed by the MultiAgency platform for an app. The platform relays the signature; executing the swap is a separate step.",
  ].join(" <br>");
}

/** The text a DAO's stop signs: which agent, on which host, and exactly what the platform then does. */
export const daoStopText = ({ host, dao, agent, agentId }: { host: string; dao: string; agent: string; agentId: string }) => [
  `Stop MultiAgency agent ${agent} (${agentId}) on ${host}`,
  `Owner: ${dao}`,
  "End every app consent for this agent given before this stop is applied, and turn its autopilot off.",
].join("\n");

/** The public page where anyone files a DAO's stop of its agent, and where a passed stop is applied. */
export const stopUrl = ({ host, dao, agent }: { host: string; dao: string; agent: string }) => `https://${host}/confirm/dao/stop/${dao}/${agent}`;

/** What a stop's proposal says. */
export function daoStopDescription(request: Pick<DaoStopRequest, "agent" | "agentId" | "dao" | "votingUntil" | "id" | "host">) {
  return [
    `* Proposal Action: Stop agent ${request.agent} (${request.agentId}): end every app consent for it given before this stop is applied and turn its autopilot off`,
    `* Signing window closes: ${new Date(request.votingUntil).toISOString()} (a vote passed by then applies when the stop page is next opened)`,
    `* Signs: NEP-413 hash ${request.id} for ${request.host} as the agents' owner (v1.signer, path agent-owner)`,
    `* Check before voting: ${checkUrl(request)} (the exact text, and its hash recomputed)`,
    `* Notes: Filed by the MultiAgency platform with no app involved. Once it passes, open ${stopUrl(request)} to apply it.`,
  ].join(" <br>");
}

/** The consent a found signature completes: the DAO's derived key signed the request's exact text and nonce. */
export function daoConsent(request: DaoConsentRequest, signature: Buffer): VerifiedConsent {
  return { version: 1, id: createHash("sha256").update(signature.toString("hex")).digest("hex"), deployment: request.deployment,
    host: request.host, organization: request.organization, owner: request.dao, agent: request.agent, agentId: request.agentId,
    scopes: request.scopes, expiresAt: request.expiresAt, message: request.message, nonce: request.nonce,
    publicKey: request.signer.public_key, signature: signature.toString("base64"), signer: "dao" };
}

/** Pending and settled DAO consent requests, one file each. Additive state: nothing else reads it. */
export class DaoRequests {
  private readonly dir: string;
  constructor(root: string) { this.dir = join(root, "dao-requests"); }
  read(id: string) { return hex64.safeParse(id).success ? readRecord(join(this.dir, `${id}.json`), Request) : null; }
  private list() {
    let files: string[];
    try { files = readdirSync(this.dir).filter(file => file.endsWith(".json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return files.map(file => this.read(file.slice(0, -5))).filter(r => r !== null);
  }
  /**
   * Throws what `file` would refuse with, so a caller can check before reading the chain. Removes requests finished more
   * than `DAO_REQUEST_RETENTION_MS` ago first (the access log, `accessLog`, keeps their history), so the records stay bounded.
   */
  admit(deployment: string, now = Date.now()) {
    const kept = this.prune(now).filter(r => r.deployment === deployment);
    if (kept.filter(r => !settled(r) && r.votingUntil > now).length >= MAX_PENDING_DAO_REQUESTS)
      throw new BadRequest("This deployment has too many DAO requests waiting for a vote. Let some pass or lapse first.", "dao_requests_limited");
    if (kept.filter(r => r.createdAt > now - DAY).length >= MAX_DAO_REQUESTS_PER_DAY)
      throw new BadRequest(`This deployment filed ${MAX_DAO_REQUESTS_PER_DAY} DAO requests in the last day. File again later.`, "dao_requests_limited");
  }
  /** Removes finished requests past retention; answers the rest. */
  private prune(now: number) {
    return this.list().filter(r => {
      // Its last moment: the vote window, a stop's applying, or the expiry a recorded signature completes until.
      const last = Math.max(r.votingUntil, r.kind === "stop" ? r.done?.at ?? 0 : r.signature ? r.expiresAt : 0);
      if (!finished(r, now) || now - last < DAO_REQUEST_RETENTION_MS) return true;
      rmSync(join(this.dir, `${r.id}.json`), { force: true });
      return false;
    });
  }
  private write(record: DaoRequest) {
    privateDirectory(this.dir);
    writeAtomic(join(this.dir, `${record.id}.json`), JSON.stringify(Request.parse(record)) + "\n", 0o600);
    return record;
  }
  /** A consent request: its vote must pass before the consent expires, and within Sputnik's default proposal period. */
  file(request: Omit<DaoConsentRequest, "version" | "kind" | "consent" | "votingUntil" | "description">, now = Date.now()) {
    this.admit(request.deployment, now);
    const votingUntil = Math.min(request.expiresAt, now + MAX_PROPOSAL_MS);
    return this.write({ ...request, version: 1, kind: "consent", votingUntil, description: daoConsentDescription({ ...request, votingUntil }), consent: null }) as DaoConsentRequest;
  }
  /** A proposal vote: it must pass before the proposal expires (`expiresAt`), and within the proposal period. */
  fileVote(request: Omit<DaoVoteRequest, "version" | "kind" | "relayed" | "votingUntil" | "description">, now = Date.now()) {
    this.admit(request.deployment, now);
    const votingUntil = Math.min(request.expiresAt, now + MAX_PROPOSAL_MS);
    return this.write({ ...request, version: 1, kind: "proposal", votingUntil, description: daoVoteDescription({ ...request, votingUntil }), relayed: null }) as DaoVoteRequest;
  }
  /** A setup request: its vote must pass before the setup text expires (at most the proposal period). */
  fileSetup(request: Omit<DaoSetupRequest, "version" | "kind" | "consent" | "reserved" | "votingUntil" | "description">, now = Date.now()) {
    this.admit(request.deployment, now);
    const votingUntil = Math.min(request.expiresAt, now + MAX_PROPOSAL_MS);
    return this.write({ ...request, version: 1, kind: "setup", votingUntil, description: daoSetupDescription({ ...request, votingUntil }),
      consent: null, reserved: null }) as DaoSetupRequest;
  }
  settle(id: string, consent: string) {
    const record = this.read(id);
    if (record?.kind !== "consent") throw new Error(`No DAO consent request ${id}`);
    this.write({ ...record, consent });
  }
  reserved(id: string, consent: string, agent: string) {
    const record = this.read(id);
    if (record?.kind !== "setup") throw new Error(`No DAO setup request ${id}`);
    return this.write({ ...record, consent, reserved: agent }) as DaoSetupRequest;
  }
  /** Records the DAO's verified signature before anything is done with it. */
  signed(id: string, signature: Buffer) {
    const record = this.read(id);
    if (!record) throw new Error(`No DAO request ${id}`);
    return this.write({ ...record, signature: signature.toString("base64") });
  }
  /** A stop request: one at a time per agent and host, open until its vote window closes. */
  fileStop(request: Omit<DaoStopRequest, "version" | "kind" | "done" | "deployment" | "organization" | "votingUntil" | "description">, now = Date.now()) {
    const votingUntil = Math.min(request.expiresAt, now + MAX_PROPOSAL_MS);
    return this.write({ ...request, version: 1, kind: "stop", deployment: "", organization: "", votingUntil,
      description: daoStopDescription({ ...request, votingUntil }), done: null }) as DaoStopRequest;
  }
  /** Stop requests for an agent on a host, newest first. */
  stops(agent: string, host: string) {
    return this.list().filter((r): r is DaoStopRequest => r.kind === "stop" && r.agent === agent && r.host === host).sort((a, b) => b.createdAt - a.createdAt);
  }
  stopped(id: string, done: NonNullable<DaoStopRequest["done"]>) {
    const record = this.read(id);
    if (record?.kind !== "stop") throw new Error(`No DAO stop request ${id}`);
    return this.write({ ...record, done }) as DaoStopRequest;
  }
  /** A stop whose window closed with no signature found, looked for once more: a new one may now be filed. */
  lapse(id: string) {
    const record = this.read(id);
    if (record?.kind !== "stop") throw new Error(`No DAO stop request ${id}`);
    return this.write({ ...record, lapsed: true }) as DaoStopRequest;
  }
  /**
   * Marks the stop's agent's consent requests filed by `cutoff` and not yet stored, so they never are. Requests filed
   * after it are the DAO's later choice and stay as they are.
   */
  endFiledBefore(stop: DaoStopRequest, cutoff: number) {
    for (const r of this.list())
      if (r.kind === "consent" && r.host === stop.host && r.agent === stop.agent && r.createdAt <= cutoff && !r.consent && !r.stoppedBy)
        this.write({ ...r, stoppedBy: stop.id });
  }
  /**
   * A stop of this agent that ends a consent request filed at `filedAt`: one applied since (its cutoff is later), or one
   * the DAO signed that isn't applied yet, whose cutoff will be.
   */
  stopEnding(agent: string, host: string, filedAt: number) {
    return this.stops(agent, host).find(s => s.done ? s.done.at >= filedAt : !!s.signature);
  }
  relayed(id: string, state: string, now = Date.now()) {
    const record = this.read(id);
    if (record?.kind !== "proposal") throw new Error(`No DAO vote request ${id}`);
    return this.write({ ...record, relayed: { at: now, state } }) as DaoVoteRequest;
  }
}
