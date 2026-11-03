import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { daoPolicy } from "../chain.js";
import { z } from "zod";
import { proposalAndVote, proposalTransaction } from "../dao-owner.js";
import { readJson, sendJson as json } from "../http.js";
import { nep413Hash, verifyEd25519 } from "../nep413.js";
import { chainKeyState, hourlyLimit, type KeyLookup, type KeyStateLookup } from "../signin.js";
import { appendSynced } from "../synced.js";
import type { AgentEntry } from "./config.js";
import { ownerPrepareOutput } from "../contract/owner-outputs.js";
import { consentKeyHolds, AppConsents, AppCredentials, appMayCall, appMayPrepare, proposalSignatureProblem, setupConsent, submittedCorrelation, UNBORN, verifyConsent, verifySetup, type ConsentRecord } from "./app-access.js";
import { AppConfirms } from "./app-confirm.js";
import { chainDaoVotes, daoConsent, DaoRequests, type DaoVotes, publicDaoRequest, verifyDaoConsentText } from "./app-dao.js";
import { AuthorityUnanswered, chainDaoOwner, type DaoOwnerReads, resolveDaoAuthority, resolveWalletAuthority } from "./machine-authority.js";
import { forwardRpc } from "./rpc-proxy.js";

const ROOT = ".app-access";
const credentials = new AppCredentials(ROOT), consents = new AppConsents(ROOT), daoRequests = new DaoRequests(ROOT);
export const confirms = new AppConfirms(ROOT);
export const APP_ROOT = ROOT;
const mayUse = hourlyLimit(1_200);
const publicConsent = ({ message: _m, nonce: _n, signature: _s, ...record }: ConsentRecord) => record;

const FOLLOW_CREATION = new Set(["owner/status", "owner/actions", "owner/pending"]);
const daoConsentFiling = z.strictObject({ message: z.string().min(1).max(2_048) });

/** Reserves (or finds) and starts the hosted agent for a wallet owner, area, app deployment and Organization; throws to refuse. */
export type HostedSetup = (input: { owner: string; area: "treasury" | "payables"; deployment: string; organization: string }) => Promise<AgentEntry>;
/**
 * An agent an app set up belongs to that deployment and Organization: no other deployment or Organization reaches it,
 * whatever consent is signed, since a consent names the agent by a generated name its owner can't tell apart.
 */
const reachable = (agent: AgentEntry, deployment: string, organization?: string) => {
  const scope = agent as { deployment?: string; organization?: string };
  return scope.deployment === undefined || (scope.deployment === deployment && (organization === undefined || scope.organization === organization));
};

/**
 * `/apps/v1`: server-to-server routes for an app deployment. Every request carries the deployment's service
 * credential; every agent call also needs a live owner consent for that Organization and agent, and the owner's current,
 * provider-confirmed ownership. Browsers never reach these routes.
 */
/** Chain reads the routes make, replaceable in tests. */
export type AppRouteOptions = { keyState?: KeyStateLookup; setup?: HostedSetup; daoOwner?: DaoOwnerReads; daoVotes?: DaoVotes };

export async function appRoutes(req: IncomingMessage, res: ServerResponse, pathname: string, host: string,
  selected: AgentEntry[], stopping: () => boolean, options: AppRouteOptions = {}): Promise<boolean> {
  if (!pathname.startsWith("/apps/")) return false;
  try { return await route(req, res, pathname, host, selected, stopping, options); }
  catch (error) {
    // An unanswered check decides nothing: the app reads again or resends the same body, never asks for a new signature.
    if (!(error instanceof AuthorityUnanswered)) throw error;
    if (res.headersSent) res.destroy();
    else json(res, 503, { error: "Ownership or the signing key couldn't be checked now. Nothing was stored or forwarded; try again." });
    return true;
  }
}

async function route(req: IncomingMessage, res: ServerResponse, pathname: string, host: string,
  selected: AgentEntry[], stopping: () => boolean, options: AppRouteOptions): Promise<boolean> {
  const keyState = options.keyState ?? chainKeyState;
  const daoOwner = options.daoOwner ?? chainDaoOwner, daoVotes = options.daoVotes ?? chainDaoVotes;
  const lookup: KeyLookup = async (account, key) => {
    let state: Awaited<ReturnType<KeyStateLookup>>;
    try { state = await keyState(account, key); } catch { throw new AuthorityUnanswered(); }
    return state === "absent" ? null : state;
  };
  if (req.headers.origin !== undefined || req.headers.cookie !== undefined) {
    json(res, 403, { error: "Use the app server, without browser credentials." }); return true;
  }
  const credential = credentials.authenticate(req.headers.authorization, host);
  if (!credential) { json(res, 401, { error: "Invalid, expired or revoked app credential" }); return true; }
  if (!mayUse(credential.id)) { json(res, 429, { error: "Request limit reached" }); return true; }
  const url = new URL(req.url ?? "/", "http://gateway");

  // What the owner signs names the agent's current provider ID, so the app reads it here first.
  const identity = pathname.match(/^\/apps\/v1\/agents\/([a-z0-9-]{1,32})$/);
  if (identity) {
    if (req.method !== "GET") { json(res, 405, { error: "Use GET" }); return true; }
    const agent = selected.find(a => a.name === identity[1] && reachable(a, credential.deployment));
    const wallet = agent && await resolveWalletAuthority(agent.owner, agent);
    const authority = wallet ?? (agent && await resolveDaoAuthority(agent, daoOwner));
    if (!agent || !authority) { json(res, 404, { error: "No agent of that name here, or its owner couldn't be confirmed" }); return true; }
    json(res, 200, { agent: agent.name, owner: agent.owner, agentId: authority.agentId, created: authority.agentId !== null,
      host: host.toLowerCase(), deployment: credential.deployment, signer: wallet ? "wallet" : "dao" }); return true;
  }

  // A wallet owner's signed request for a hosted agent. Its signature also lets the app prepare that agent's
  // creation (owner scope), only while the agent isn't created; afterwards the owner signs a consent naming its ID.
  if (pathname === "/apps/v1/setup") {
    if (req.method !== "POST") { json(res, 405, { error: "Use POST" }); return true; }
    if (!options.setup) { json(res, 403, { error: "Agent setup isn't available on this host" }); return true; }
    const verified = await verifySetup(await readJson(req), { host, deployment: credential.deployment }, lookup);
    let dao: unknown;
    try { dao = await daoPolicy(verified.setup.owner); }
    catch { json(res, 503, { error: "Whether the owner is a DAO couldn't be checked. Nothing was set up." }); return true; }
    if (dao) { json(res, 409, { error: "DAO-owned agents can't be set up from the app yet. Nothing was set up." }); return true; }
    if (stopping()) { json(res, 503, { error: "Gateway is stopping. Nothing was set up." }); return true; }
    // Whether its consent can be stored, before reserving anything for it.
    consents.admit(setupConsent(verified, "pending"));
    const known = new Set(selected.map(a => a.name));
    let agent: AgentEntry;
    try { agent = await options.setup({ owner: verified.setup.owner, area: verified.setup.area, deployment: credential.deployment, organization: verified.setup.organization }); }
    catch (error) { json(res, 409, { error: error instanceof Error ? error.message : "The agent couldn't be set up" }); return true; }
    // A reservation found again may belong to a created agent, which a setup consent must never reach.
    if (known.has(agent.name)) {
      const authority = await resolveWalletAuthority(agent.owner, agent);
      if (!authority) { json(res, 503, { error: "Whether this agent is already created couldn't be checked. Nothing was stored." }); return true; }
      if (authority.agentId !== null) { json(res, 409, { error: "This owner's agent for that area is already created. Ask the owner to sign a consent for it." }); return true; }
    }
    const record = consents.store(setupConsent(verified, agent.name));
    appendSynced(join(ROOT, "access.jsonl"), { at: new Date().toISOString(), deployment: credential.deployment, credential: credential.id,
      event: "setup", consent: record.id, organization: record.organization, owner: record.owner, agent: record.agent, area: verified.setup.area });
    json(res, 201, { agent: agent.name, consent: publicConsent(record) }); return true;
  }

  if (pathname === "/apps/v1/consents") {
    if (req.method === "GET") {
      const organization = url.searchParams.get("organization") ?? undefined;
      json(res, 200, { consents: consents.list({ deployment: credential.deployment, organization }).filter(c => c.host === host.toLowerCase()).map(publicConsent) }); return true;
    }
    if (req.method !== "POST") { json(res, 405, { error: "Use GET or POST" }); return true; }
    const verified = await verifyConsent(await readJson(req), { host, deployment: credential.deployment }, lookup);
    const agent = selected.find(a => a.name === verified.agent && reachable(a, credential.deployment, verified.organization));
    if (!agent || agent.owner !== verified.owner) { json(res, 403, { error: "This host has no such agent owned by the signer" }); return true; }
    const authority = await resolveWalletAuthority(verified.owner, agent);
    if (!authority) { json(res, 409, { error: "Current wallet ownership could not be verified. A DAO-owned agent's consent is filed at /apps/v1/dao-consents for the DAO's vote." }); return true; }
    if (authority.agentId === null) { json(res, 409, { error: "This agent isn't created yet. Use the setup consent to create it, then ask the owner to sign." }); return true; }
    if (authority.agentId !== verified.agentId) { json(res, 409, { error: "The consent names another agent identity. Read the agent again and ask the owner to sign." }); return true; }
    if (stopping()) { json(res, 503, { error: "Gateway is stopping. Nothing was stored." }); return true; }
    const record = consents.store(verified);
    appendSynced(join(ROOT, "access.jsonl"), { at: new Date().toISOString(), deployment: credential.deployment, credential: credential.id,
      event: "consent", consent: record.id, organization: record.organization, owner: record.owner, agent: record.agent, scopes: record.scopes });
    json(res, 201, { consent: publicConsent(record) }); return true;
  }

  // A DAO owner's consent, signed by its own vote (coordination/p5-treasury-dao-consent.md): the platform picks the nonce,
  // records the request and answers the proposal a member files; the DAO's signature is found on chain afterwards.
  if (pathname === "/apps/v1/dao-consents") {
    if (req.method !== "POST") { json(res, 405, { error: "Use POST" }); return true; }
    const body = daoConsentFiling.safeParse(await readJson(req));
    if (!body.success) { json(res, 400, { error: "Send the canonical consent text as message." }); return true; }
    const { text, expiresAt } = verifyDaoConsentText(body.data.message, { host, deployment: credential.deployment });
    const agent = selected.find(a => a.name === text.agent && reachable(a, credential.deployment, text.organization));
    if (!agent || agent.owner !== text.owner) { json(res, 403, { error: "This host has no such agent owned by that DAO" }); return true; }
    const authority = await resolveDaoAuthority(agent, daoOwner);
    if (!authority) { json(res, 409, { error: "This agent isn't owned by that DAO's derived account now. Nothing was filed." }); return true; }
    if (authority.agentId === null) { json(res, 409, { error: "This agent isn't created yet. Nothing was filed." }); return true; }
    if (authority.agentId !== text.agentId) { json(res, 409, { error: "The consent names another agent identity. Read the agent again. Nothing was filed." }); return true; }
    daoRequests.admit(credential.deployment);
    const nonce = randomBytes(32), hash = nep413Hash(body.data.message, nonce, text.host).toString("hex");
    let since: number, next: number | null;
    try { [since, next] = await Promise.all([daoVotes.latestBlock(), daoVotes.nextProposalId(text.owner).catch(() => null)]); }
    catch { json(res, 503, { error: "The chain couldn't be read. Nothing was filed; try again." }); return true; }
    if (stopping()) { json(res, 503, { error: "Gateway is stopping. Nothing was filed." }); return true; }
    const record = daoRequests.file({ id: hash, kind: "consent", deployment: credential.deployment, host: text.host, organization: text.organization,
      dao: text.owner, agent: agent.name, agentId: text.agentId, scopes: text.scopes, expiresAt, createdAt: Date.now(), message: body.data.message,
      nonce: nonce.toString("base64"), signer: { account_id: authority.signer.account_id, public_key: authority.signer.public_key }, since });
    appendSynced(join(ROOT, "access.jsonl"), { at: new Date().toISOString(), deployment: credential.deployment, credential: credential.id,
      event: "dao-consent-filed", request: record.id, organization: record.organization, owner: record.dao, agent: record.agent, scopes: record.scopes });
    const bond = authority.policy.proposal_bond;
    json(res, 201, { request: publicDaoRequest(record), transactions: {
      proposal: proposalTransaction(record.dao, record.id, record.description, bond),
      proposalAndVote: next === null ? null : proposalAndVote(record.dao, record.id, record.description, bond, next) } }); return true;
  }
  const daoState = pathname.match(/^\/apps\/v1\/dao-consents\/([a-f0-9]{64})$/);
  if (daoState) {
    if (req.method !== "GET") { json(res, 405, { error: "Use GET" }); return true; }
    const record = daoRequests.read(daoState[1]!);
    if (!record || record.deployment !== credential.deployment || record.host !== host.toLowerCase()) { json(res, 404, { error: "No such DAO consent request" }); return true; }
    const settled = record.consent && consents.list({ deployment: credential.deployment }).find(c => c.id === record.consent);
    if (settled) { json(res, 200, { state: "signed", consent: publicConsent(settled) }); return true; }
    if (Date.now() >= record.votingUntil) { json(res, 410, { error: `The DAO's vote didn't pass before ${new Date(record.votingUntil).toISOString()}. File the consent again.` }); return true; }
    let signature: Buffer | null;
    try { signature = await daoVotes.findSignature(record.dao, { owner: record.signer, hash: record.id, since: record.since }); }
    catch { json(res, 503, { error: "The DAO's proposals couldn't be read now. Nothing changed; read again." }); return true; }
    if (!signature) { json(res, 200, { state: "pending", request: publicDaoRequest(record) }); return true; }
    // Only the DAO's derived key over this exact hash counts, whatever found it.
    let verified = false;
    try { verified = verifyEd25519(record.signer.public_key, Buffer.from(record.id, "hex"), signature); } catch { verified = false; }
    if (!verified) { json(res, 200, { state: "pending", request: publicDaoRequest(record) }); return true; }
    const agent = selected.find(a => a.name === record.agent && reachable(a, credential.deployment, record.organization));
    const authority = agent && agent.owner === record.dao ? await resolveDaoAuthority(agent, daoOwner) : null;
    if (!authority || authority.agentId !== record.agentId || authority.signer.public_key !== record.signer.public_key) {
      json(res, 409, { error: "The DAO signed, but the agent is no longer that DAO's agent with that identity. Nothing was stored." }); return true;
    }
    const consent = daoConsent(record, signature);
    consents.admit(consent);
    if (stopping()) { json(res, 503, { error: "Gateway is stopping. Nothing was stored; read again." }); return true; }
    const stored = consents.store(consent);
    daoRequests.settle(record.id, stored.id);
    appendSynced(join(ROOT, "access.jsonl"), { at: new Date().toISOString(), deployment: credential.deployment, credential: credential.id,
      event: "consent", signer: "dao", request: record.id, consent: stored.id, organization: stored.organization, owner: stored.owner, agent: stored.agent, scopes: stored.scopes });
    json(res, 200, { state: "signed", consent: publicConsent(stored) }); return true;
  }

  const revoke = pathname.match(/^\/apps\/v1\/consents\/([a-f0-9]{64})$/);
  if (revoke) {
    if (req.method !== "DELETE") { json(res, 405, { error: "Use DELETE" }); return true; }
    if (!consents.revoke(revoke[1]!, { deployment: credential.deployment, host })) { json(res, 404, { error: "No such consent" }); return true; }
    appendSynced(join(ROOT, "access.jsonl"), { at: new Date().toISOString(), deployment: credential.deployment, credential: credential.id, event: "revoke", consent: revoke[1] });
    json(res, 200, { revoked: true }); return true;
  }

  const call = pathname.match(/^\/apps\/v1\/o\/([A-Za-z0-9_-]{1,128})\/a\/([a-z0-9-]{1,32})\/rpc\/([A-Za-z][A-Za-z0-9]*(?:\/[A-Za-z][A-Za-z0-9]*)*)$/);
  if (!call) { json(res, 404, { error: "Not found" }); return true; }
  if (req.method !== "POST") { json(res, 405, { error: "Use POST" }); return true; }
  const [, organization, name, path] = call as unknown as [string, string, string, string];
  const agent = selected.find(a => a.name === name && reachable(a, credential.deployment, organization));
  const live = agent ? consents.live({ deployment: credential.deployment, host, organization, agent: name }).filter(c => c.owner === agent.owner) : [];
  // The scope check below would refuse this too; refusing here spares the ownership lookup's provider and chain reads.
  if (!agent || !live.length) { json(res, 403, { error: "No live owner consent covers this Organization and agent" }); return true; }
  const input = await readJson(req);
  // Only the owner's own wallet signs through the app (no DAO path until DAO consent exists), and only what it
  // can read or what the platform built entirely.
  const prepared = path === "owner/prepare" ? appMayPrepare(input) : undefined;
  if (prepared === null) {
    json(res, 403, { error: "Through an app, the owner's wallet (signer \"wallet\") signs only: agent creation without payees, freeze, " +
      "unfreeze, grants, policy edits and votes on held payouts." }); return true;
  }
  // An action held for the confirm page is signed and submitted there only; an unreadable body is the agent's to refuse.
  const submitted = path === "owner/submit" ? submittedCorrelation(input) : null;
  if (submitted !== null && confirms.holds(submitted)) {
    json(res, 403, { error: "This owner action is signed on the platform's confirm page, not through the app." }); return true;
  }
  const body = JSON.stringify(input);
  // A DAO's consents answer to the DAO's derived account now, re-read on every call; a wallet's to the wallet's.
  const byDao = live.some(c => c.signer === "dao");
  const authority = byDao ? await resolveDaoAuthority(agent, daoOwner) : await resolveWalletAuthority(agent.owner, agent);
  // A setup consent (UNBORN) acts only while the agent isn't created; afterwards it may still follow the creation it
  // relayed (status reads), and nothing else. Any other consent matches only the agent it names.
  const matches = (c: ConsentRecord) => (c.signer === "dao") === byDao && (c.agentId === (authority!.agentId ?? UNBORN) ||
    (c.agentId === UNBORN && authority!.agentId !== null && FOLLOW_CREATION.has(path)));
  const consent = authority && live.find(c => matches(c) && appMayCall(c.scopes, authority.access, path));
  if (!authority || !consent) { json(res, 403, { error: "Current ownership, agent identity or consent scope could not be verified" }); return true; }
  // Removing a key is how an owner answers its compromise: the chain saying so ends the consent for good. A failed
  // lookup refuses this call only. A DAO's derived key can't be removed; its ownership was re-checked above.
  let holds = true;
  if (!byDao) {
    try { holds = await consentKeyHolds(consents, consent, keyState); }
    catch { json(res, 503, { error: "The consent's signing key couldn't be checked. Nothing was forwarded; reading again is safe." }); return true; }
  }
  // The re-check before forwarding would also refuse this call (the consent is now revoked); refusing here says why.
  if (!holds) { json(res, 403, { error: "The key that signed this consent was removed from its owner's account, so the consent was revoked" }); return true; }
  // The owner key a created agent answers to is the one that signed (and was checked full-access for) this consent.
  if (prepared?.type === "agent_create" && prepared.owner?.public_key !== consent.publicKey) {
    json(res, 403, { error: "Create the agent with the key that signed the setup" }); return true;
  }
  // An owner's approval or rejection of a proposal: the platform checks it is the owner's, for this host, before the agent
  // compares its text with the proposal's.
  if (path === "proposals/approve" || path === "proposals/reject") {
    const problem = await proposalSignatureProblem(input, host, agent.owner, lookup);
    if (problem) { json(res, 400, { error: `${problem} Nothing was recorded.` }); return true; }
  }
  // The checks above waited on the chain: a credential or consent revoked meanwhile, or a stop begun, refuses here.
  if (stopping() || !credentials.authenticate(req.headers.authorization, host) ||
    !consents.live({ deployment: credential.deployment, host, organization, agent: name }).some(c => c.id === consent.id)) {
    json(res, 403, { error: "Access ended before forwarding" }); return true;
  }
  appendSynced(join(ROOT, "access.jsonl"), { at: new Date().toISOString(), deployment: credential.deployment, credential: credential.id,
    event: "call", consent: consent.id, organization, owner: agent.owner, agent: name, agentId: authority.agentId, path });
  // A readable (NEP-413) intent goes to the app: its text is one the owner's wallet can show. A NEP-366 intent is held here for the
  // owner to sign on the platform's confirm page; the app gets the link, not the bytes. Anything else isn't released.
  const release = prepared && ((reply: unknown) => {
    const raw = reply as { json?: unknown; meta?: unknown };
    const output = ownerPrepareOutput.safeParse(raw.json);
    const standard = output.success ? output.data.intent?.standard : undefined;
    if (standard === "nep413") return null;
    const log = (event: string) => appendSynced(join(ROOT, "access.jsonl"), { at: new Date().toISOString(), deployment: credential.deployment,
      credential: credential.id, event, consent: consent.id, organization, owner: agent.owner, agent: name, action: prepared.type,
      correlationId: (raw.json as { correlationId?: unknown } | undefined)?.correlationId ?? null });
    if (!output.success || standard !== "nep366" || output.data.signer?.type !== "near") {
      log("withheld");
      return "This owner action came back in a form the platform can't show the owner. It wasn't released and expires unsigned.";
    }
    const { intent, signer, ...answer } = output.data;
    const { token } = confirms.hold({ deployment: credential.deployment, host: host.toLowerCase(), organization, owner: agent.owner, agent: name,
      agentId: authority.agentId, consent: consent.id, correlationId: answer.correlationId, type: prepared.type, action: prepared,
      policy: answer.policy ?? null, summary: answer.preview.summary ?? null, expiresAt: answer.expiresAt,
      intent: intent as never, signer: signer as never });
    log("confirm");
    // The serializer's notes about the withheld intent go with it.
    const meta = Array.isArray(raw.meta) ? raw.meta.filter(entry => !(Array.isArray(entry) && entry[1] === "intent")) : [];
    return { answer: { json: { ...answer, confirm: { url: `https://${host.toLowerCase()}/confirm/${token}`, expiresAt: answer.expiresAt } }, meta } };
  });
  // A proposal is bound to the consent it was made under and the host its owner signs for; it is withdrawn once that
  // consent is no longer among this app's live consents for the agent.
  const context = path.startsWith("proposals/") ? { consent: consent.id, host: host.toLowerCase(),
    consents: live.filter(c => matches(c) && c.scopes.includes("treasury")).map(c => c.id) } : undefined;
  forwardRpc(req, res, agent, path, undefined, body, `app:${credential.deployment}:${organization}`, release || undefined, context);
  return true;
}
