import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DAO_CONSENT_SCOPES } from "../contract/app-access.js";
import { AppScope, parseConsentMessage } from "../contract/app-consent.js";
import { MAX_PROPOSAL_MS } from "../contract/treasury-proposals.js";
import { nextProposalId } from "../chain.js";
import { findSignature, latestBlock } from "../dao-owner.js";
import { BadRequest } from "../http.js";
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

const common = {
  version: z.literal(1),
  /** The NEP-413 hash (hex) the DAO's key signs: unique, since the platform picked the nonce. */
  id: hex64, deployment: z.string(), host: z.string(), organization: z.string(), dao: z.string(), agent: z.string(), agentId: z.string(),
  expiresAt: z.number().int().positive(), votingUntil: z.number().int().positive(), createdAt: z.number().int().nonnegative(),
  message: z.string(), nonce: z.string(), signer: z.strictObject({ account_id: z.string(), public_key: z.string() }),
  /** The block height read before filing: no proposal can have signed this hash earlier. */
  since: z.number().int().nonnegative(), description: z.string(),
};
const ConsentRequest = z.strictObject({ ...common, kind: z.literal("consent"), scopes: z.array(AppScope),
  /** The stored consent's id once the signature was found. */
  consent: hex64.nullable() });
/** A vote on a Treasury proposal, under the DAO consent `under`; `relayed` once the signature reached the agent. */
const VoteRequest = z.strictObject({ ...common, kind: z.literal("proposal"), proposal: z.string(), verdict: z.enum(["approve", "reject"]),
  under: hex64, relayed: z.strictObject({ at: z.number().int(), state: z.string() }).nullable() });
const Request = z.discriminatedUnion("kind", [ConsentRequest, VoteRequest]);
export type DaoRequest = z.infer<typeof Request>;
export type DaoConsentRequest = z.infer<typeof ConsentRequest>;
export type DaoVoteRequest = z.infer<typeof VoteRequest>;
const settled = (r: DaoRequest) => r.kind === "consent" ? r.consent !== null : r.relayed !== null;
export const publicDaoRequest = ({ id, dao, organization, agent, agentId, scopes, expiresAt, votingUntil, description }: DaoConsentRequest) =>
  ({ id, dao, organization, agent, agentId, scopes, expiresAt, votingUntil, hash: id, description });
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

/** What the DAO's proposal says: the consent's terms, the vote's deadline, and the hash its key signs. */
export function daoConsentDescription(request: Pick<DaoConsentRequest, "deployment" | "organization" | "agent" | "agentId" | "scopes" | "expiresAt" | "votingUntil" | "id" | "host">) {
  return [
    `* Proposal Action: Consent: app deployment ${request.deployment} may act for Organization ${request.organization} on agent ` +
      `${request.agent} (${request.agentId}) with ${[...request.scopes].sort().join(", ")} until ${new Date(request.expiresAt).toISOString()}`,
    `* Signing window closes: ${new Date(request.votingUntil).toISOString()} (approve before then, or the consent isn't stored)`,
    `* Signs: NEP-413 hash ${request.id} for ${request.host} as the agents' owner (v1.signer, path agent-owner)`,
    "* Notes: Filed by the MultiAgency platform for an app. The signature gives the app only these scopes; it can't sign for the DAO.",
  ].join(" <br>");
}

/** What the DAO's proposal says for a Treasury proposal vote: the platform's own text of its terms, verbatim. */
export function daoVoteDescription(request: Pick<DaoVoteRequest, "message" | "votingUntil" | "id" | "host">) {
  return [
    ...request.message.split("\n").map((line, i) => i === 0 ? `* Proposal Action: ${line}` : `* ${line}`),
    `* Signing window closes: ${new Date(request.votingUntil).toISOString()} (approve before then, or the vote isn't relayed)`,
    `* Signs: NEP-413 hash ${request.id} for ${request.host} as the agents' owner (v1.signer, path agent-owner)`,
    "* Notes: Filed by the MultiAgency platform for an app. The platform relays the signature; executing the swap is a separate step.",
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
  /** Throws what `file` would refuse with, so a caller can check before reading the chain. */
  admit(deployment: string, now = Date.now()) {
    if (this.list().filter(r => r.deployment === deployment && !settled(r) && r.votingUntil > now).length >= MAX_PENDING_DAO_REQUESTS)
      throw new BadRequest("This deployment has too many DAO requests waiting for a vote. Let some pass or lapse first.");
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
  settle(id: string, consent: string) {
    const record = this.read(id);
    if (record?.kind !== "consent") throw new Error(`No DAO consent request ${id}`);
    this.write({ ...record, consent });
  }
  relayed(id: string, state: string, now = Date.now()) {
    const record = this.read(id);
    if (record?.kind !== "proposal") throw new Error(`No DAO vote request ${id}`);
    return this.write({ ...record, relayed: { at: now, state } }) as DaoVoteRequest;
  }
}
