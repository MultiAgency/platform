import type { IncomingMessage, ServerResponse } from "node:http";
import { daoPolicy } from "../chain.js";
import { z } from "zod";
import { readJson, sendJson as json } from "../http.js";
import { chainKeyState, hourlyLimit, type KeyLookup, type KeyStateLookup } from "../signin.js";
import { appendSynced } from "../synced.js";
import type { AgentEntry } from "./config.js";
import { daoScopesCover } from "../contract/app-access.js";
import { ownerPrepareOutput } from "../contract/owner-outputs.js";
import { mayCall } from "./allowlist.js";
import { accessLog, consentKeyHolds, AppConsents, AppCredentials, appMayCall, DEFAULT_REQUESTS_PER_HOUR, appMayPrepare, appMayPrepareForDao, proposalSignatureProblem, setupConsent, submittedCorrelation, UNBORN, verifyConsent, verifySetup, type ConsentRecord } from "./app-access.js";
import { AppConfirms } from "./app-confirm.js";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { proposalText, proposalView } from "../contract/treasury-proposals.js";
import type { Router } from "../router.js";
import { agentOrigin } from "./agent-origin.js";
import { chainDaoVotes, daoConsent, type DaoConsentRequest, type DaoFiled, type DaoRequest, DaoRequests, daoSetupConsent, type DaoVotes, publicDaoRequest, publicDaoSetup, publicDaoVote, verifyDaoConsentText, verifyDaoSetupText } from "./app-dao.js";
import { AuthorityUnanswered, chainDaoOwner, type DaoOwnerReads, resolveDaoAuthority, resolveWalletAuthority } from "./machine-authority.js";
import { forwardRpc } from "./rpc-proxy.js";

const ROOT = ".app-access";
const credentials = new AppCredentials(ROOT), consents = new AppConsents(ROOT);
export const confirms = new AppConfirms(ROOT);
export const APP_ROOT = ROOT;
/** Each credential's requests in the hour, held to its own limit (`perHour`, which the operator sets). */
const mayUse = hourlyLimit(DEFAULT_REQUESTS_PER_HOUR);
const publicConsent = ({ message: _m, nonce: _n, signature: _s, ...record }: ConsentRecord) => record;

const FOLLOW_CREATION = new Set(["owner/status", "owner/actions", "owner/pending"]);
const daoConsentFiling = z.strictObject({ message: z.string().min(1).max(2_048) });
const daoVoteFiling = z.strictObject({ organization: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), agent: z.string().regex(/^[a-z0-9-]{1,32}$/),
  proposal: z.string().min(1).max(128), verdict: z.enum(["approve", "reject"]) });
/** The gateway's own call to an agent, as this app under one of its consents: the agent applies its usual checks. */
const agentCall = (agent: AgentEntry, deployment: string, host: string, organization: string, consent: string, live: string[]): RouterClient<Router> =>
  createORPCClient(new RPCLink({ origin: agentOrigin(agent), url: "/rpc", headers: { "x-gateway-actor": `app:${deployment}:${organization}`,
    "x-gateway-consent": consent, "x-gateway-host": host.toLowerCase(), "x-gateway-consents": live.join(",") } }));

/**
 * The areas an app may set up hosted agents for on a host: its config's `appSetup`, narrowed on a demo site to the
 * site's `hostedAreas`. One rule for both the reservation and the refusal before a DAO's vote is filed.
 */
export const appSetupAreas = (appSetup: readonly string[], site?: { hostedAreas?: readonly string[] }) =>
  appSetup.filter(area => !site || (site.hostedAreas ?? []).includes(area));

/** Reserves (or finds) and starts the hosted agent for an owner (a wallet, or a DAO by its vote), area, app deployment and Organization; throws to refuse. */
export type HostedSetup = (input: { owner: string; kind: "wallet" | "dao"; area: "treasury" | "payables"; deployment: string; organization: string }) => Promise<AgentEntry>;
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
export type AppRouteOptions = { keyState?: KeyStateLookup; setup?: HostedSetup; daoOwner?: DaoOwnerReads; daoVotes?: DaoVotes;
  /** The areas `setup` reserves agents for on this host: a DAO's setup for any other is refused before its vote is filed. */
  setupAreas?: readonly string[] };

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
  const daoOwner = options.daoOwner ?? chainDaoOwner, daoRequests = new DaoRequests(ROOT, options.daoVotes ?? chainDaoVotes);
  const lookup: KeyLookup = async (account, key) => {
    let state: Awaited<ReturnType<KeyStateLookup>>;
    try { state = await keyState(account, key); } catch { throw new AuthorityUnanswered(); }
    return state === "absent" ? null : state;
  };
  if (req.headers.origin !== undefined || req.headers.cookie !== undefined) {
    json(res, 403, { code: "browser", error: "Use the app server, without browser credentials." }); return true;
  }
  const credential = credentials.authenticate(req.headers.authorization, host);
  if (!credential) { json(res, 401, { error: "Invalid, expired or revoked app credential" }); return true; }
  // The SDK reads this as `rate_limited` (#15): refused before forwarding, so the same request may be sent once it clears.
  const now = Date.now();
  if (!mayUse(credential.id, now, credential.perHour)) {
    const after = mayUse.retryAfterSeconds(credential.id, now, credential.perHour);
    json(res, 429, { error: "Request limit reached", retryAfterSeconds: after }, { "retry-after": String(after) }); return true;
  }
  const url = new URL(req.url ?? "/", "http://gateway");
  /**
   * The DAO's signature for a request (`DaoRequests.follow`), or its answer written here (410, 503 or `pending`) and null
   * when there is none to act on.
   */
  const daoSignature = async (record: DaoRequest, pending: () => object): Promise<Buffer | null> => {
    const followed = await daoRequests.follow(record);
    if (followed.state === "signed") return followed.signature;
    if (followed.state === "expired") json(res, 410, { code: "signed_expired", error: `What the DAO signed expired at ${new Date(record.expiresAt).toISOString()}. Nothing was done; file it again.` });
    else if (followed.state === "lapsed") json(res, 410, { code: "vote_lapsed", error: `The DAO's vote didn't pass before ${new Date(record.votingUntil).toISOString()}. Nothing was done; file it again.` });
    else if (followed.state === "unreadable") json(res, 503, { error: "The DAO's proposals couldn't be read now. Nothing changed; read again." });
    else json(res, 200, pending());
    return null;
  };
  /** A filing's request and transactions, or its answer written here (503) and null when nothing was filed. */
  const daoFiled = <R extends DaoRequest>(filing: DaoFiled<R>) => {
    if (filing.state === "filed") return filing;
    json(res, 503, { error: filing.state === "stopping" ? "Gateway is stopping. Nothing was filed." : "The chain couldn't be read. Nothing was filed; try again." });
    return null;
  };
  /** The chain reads above wait: a credential revoked meanwhile ends the request before anything is stored or relayed. */
  const stillAuthorized = () => credentials.authenticate(req.headers.authorization, host) !== null;
  /**
   * Whether a DAO stop of the agent ended this consent request: marked when the stop was applied, or a stop applied since
   * it was filed, or signed and not applied yet. Checked again right before storing, with no wait between, and a stop's
   * own pass revokes every consent given before it, so a consent filed before a stop is never left live once it applies.
   */
  const endedByStop = (record: DaoConsentRequest) => !!record.stoppedBy || !!daoRequests.stopEnding(record.agent, record.host, record.createdAt);
  const stoppedAnswer = () => json(res, 409, { code: "dao_stopped", error: "The DAO stopped this agent after this consent was filed. Nothing was stored; file a new consent for the DAO's vote." });
  /** A DAO-owned agent this app reaches under a live DAO consent with `treasury`, as it is now; or why not. */
  const daoTreasury = async (name: string, organization: string) => {
    const agent = selected.find(a => a.name === name && reachable(a, credential.deployment, organization));
    if (!agent) return { code: "no_consent", error: "This host has no such agent for this app and Organization" };
    const authority = await resolveDaoAuthority(agent, daoOwner);
    if (!authority) return { code: "owner_changed", error: "This agent isn't owned by a DAO's derived account now" };
    if (authority.agentId === null) return { code: "not_created", error: "This DAO's agent isn't created yet" };
    const covering = consents.live({ deployment: credential.deployment, host, organization, agent: name })
      .filter(c => c.signer === "dao" && c.owner === agent.owner && c.agentId === authority.agentId && c.scopes.includes("treasury"));
    if (!covering.length) return { code: "no_consent", error: "No live DAO consent with treasury covers this Organization and agent" };
    // The longest-lived one, so a vote filed under it has the most time to pass.
    const consent = covering.reduce((best, c) => c.expiresAt > best.expiresAt ? c : best);
    return { agent, authority, consent, live: covering.map(c => c.id) };
  };

  // What the owner signs names the agent's current provider ID, so the app reads it here first.
  const identity = pathname.match(/^\/apps\/v1\/agents\/([a-z0-9-]{1,32})$/);
  if (identity) {
    if (req.method !== "GET") { json(res, 405, { code: "invalid_request", error: "Use GET" }); return true; }
    const agent = selected.find(a => a.name === identity[1] && reachable(a, credential.deployment));
    const wallet = agent && await resolveWalletAuthority(agent.owner, agent);
    const authority = wallet ?? (agent && await resolveDaoAuthority(agent, daoOwner));
    if (!agent || !authority) { json(res, 404, { code: "not_found", error: "No agent of that name here, or its owner couldn't be confirmed" }); return true; }
    json(res, 200, { agent: agent.name, owner: agent.owner, agentId: authority.agentId, created: authority.agentId !== null,
      host: host.toLowerCase(), deployment: credential.deployment, signer: wallet ? "wallet" : "dao" }); return true;
  }

  // A wallet owner's signed request for a hosted agent. Its signature also lets the app prepare that agent's
  // creation (owner scope), only while the agent isn't created; afterwards the owner signs a consent naming its ID.
  if (pathname === "/apps/v1/setup") {
    if (req.method !== "POST") { json(res, 405, { code: "invalid_request", error: "Use POST" }); return true; }
    if (!options.setup) { json(res, 403, { code: "setup_unavailable", error: "Agent setup isn't available on this host" }); return true; }
    const verified = await verifySetup(await readJson(req), { host, deployment: credential.deployment }, lookup);
    let dao: unknown;
    try { dao = await daoPolicy(verified.setup.owner); }
    catch { json(res, 503, { error: "Whether the owner is a DAO couldn't be checked. Nothing was set up." }); return true; }
    if (dao) { json(res, 409, { code: "dao_owned", error: "A DAO's setup is signed by its vote: file it at /apps/v1/dao-setups. Nothing was set up." }); return true; }
    if (stopping()) { json(res, 503, { error: "Gateway is stopping. Nothing was set up." }); return true; }
    // Whether its consent can be stored, before reserving anything for it.
    consents.admit(setupConsent(verified, "pending"));
    const known = new Set(selected.map(a => a.name));
    let agent: AgentEntry;
    try { agent = await options.setup({ owner: verified.setup.owner, kind: "wallet", area: verified.setup.area, deployment: credential.deployment, organization: verified.setup.organization }); }
    catch (error) { json(res, 409, { code: "setup_failed", error: error instanceof Error ? error.message : "The agent couldn't be set up" }); return true; }
    // A reservation found again may belong to a created agent, which a setup consent must never reach.
    if (known.has(agent.name)) {
      const authority = await resolveWalletAuthority(agent.owner, agent);
      if (!authority) { json(res, 503, { error: "Whether this agent is already created couldn't be checked. Nothing was stored." }); return true; }
      if (authority.agentId !== null) { json(res, 409, { code: "already_created", error: "This owner's agent for that area is already created. Ask the owner to sign a consent for it." }); return true; }
    }
    // Reserving and the re-read above wait: a credential revoked or a stop begun meanwhile stores nothing.
    if (stopping()) { json(res, 503, { error: "Gateway is stopping. Nothing was stored; send the same setup again." }); return true; }
    if (!stillAuthorized()) { json(res, 403, { code: "access_ended", error: "Access ended before storing. Nothing was stored." }); return true; }
    const record = consents.store(setupConsent(verified, agent.name));
    appendSynced(accessLog(ROOT), { at: new Date().toISOString(), deployment: credential.deployment, credential: credential.id,
      event: "setup", consent: record.id, organization: record.organization, owner: record.owner, agent: record.agent, area: verified.setup.area });
    json(res, 201, { agent: agent.name, consent: publicConsent(record) }); return true;
  }

  if (pathname === "/apps/v1/consents") {
    if (req.method === "GET") {
      const organization = url.searchParams.get("organization") ?? undefined;
      json(res, 200, { consents: consents.list({ deployment: credential.deployment, organization }).filter(c => c.host === host.toLowerCase()).map(publicConsent) }); return true;
    }
    if (req.method !== "POST") { json(res, 405, { code: "invalid_request", error: "Use GET or POST" }); return true; }
    const verified = await verifyConsent(await readJson(req), { host, deployment: credential.deployment }, lookup);
    const agent = selected.find(a => a.name === verified.agent && reachable(a, credential.deployment, verified.organization));
    if (!agent || agent.owner !== verified.owner) { json(res, 403, { code: "not_owner", error: "This host has no such agent owned by the signer" }); return true; }
    const authority = await resolveWalletAuthority(verified.owner, agent);
    if (!authority) { json(res, 409, { code: "owner_changed", error: "Current wallet ownership could not be verified. A DAO-owned agent's consent is filed at /apps/v1/dao-consents for the DAO's vote." }); return true; }
    if (authority.agentId === null) { json(res, 409, { code: "not_created", error: "This agent isn't created yet. Use the setup consent to create it, then ask the owner to sign." }); return true; }
    if (authority.agentId !== verified.agentId) { json(res, 409, { code: "agent_changed", error: "The consent names another agent identity. Read the agent again and ask the owner to sign." }); return true; }
    if (stopping()) { json(res, 503, { error: "Gateway is stopping. Nothing was stored." }); return true; }
    if (!stillAuthorized()) { json(res, 403, { code: "access_ended", error: "Access ended before storing. Nothing was stored." }); return true; }
    const record = consents.store(verified);
    appendSynced(accessLog(ROOT), { at: new Date().toISOString(), deployment: credential.deployment, credential: credential.id,
      event: "consent", consent: record.id, organization: record.organization, owner: record.owner, agent: record.agent, scopes: record.scopes });
    json(res, 201, { consent: publicConsent(record) }); return true;
  }

  // A DAO owner's consent, signed by its own vote (coordination/p5-treasury-dao-consent.md): the platform picks the nonce,
  // records the request and answers the proposal a member files; the DAO's signature is found on chain afterwards.
  if (pathname === "/apps/v1/dao-consents") {
    if (req.method !== "POST") { json(res, 405, { code: "invalid_request", error: "Use POST" }); return true; }
    const body = daoConsentFiling.safeParse(await readJson(req));
    if (!body.success) { json(res, 400, { code: "invalid_request", error: "Send the canonical consent text as message." }); return true; }
    const { text, expiresAt } = verifyDaoConsentText(body.data.message, { host, deployment: credential.deployment });
    const agent = selected.find(a => a.name === text.agent && reachable(a, credential.deployment, text.organization));
    if (!agent || agent.owner !== text.owner) { json(res, 403, { code: "not_owner", error: "This host has no such agent owned by that DAO" }); return true; }
    const authority = await resolveDaoAuthority(agent, daoOwner);
    if (!authority) { json(res, 409, { code: "owner_changed", error: "This agent isn't owned by that DAO's derived account now. Nothing was filed." }); return true; }
    if (authority.agentId === null) { json(res, 409, { code: "not_created", error: "This agent isn't created yet. Nothing was filed." }); return true; }
    if (authority.agentId !== text.agentId) { json(res, 409, { code: "agent_changed", error: "The consent names another agent identity. Read the agent again. Nothing was filed." }); return true; }
    const filed = daoFiled(await daoRequests.file({ kind: "consent", deployment: credential.deployment, host: text.host, organization: text.organization,
      dao: text.owner, agent: agent.name, agentId: text.agentId, scopes: text.scopes, expiresAt, message: body.data.message,
      signer: { account_id: authority.signer.account_id, public_key: authority.signer.public_key } }, { bond: authority.policy.proposal_bond, stopping,
      log: record => ({ deployment: credential.deployment, credential: credential.id, event: "dao-consent-filed", request: record.id,
        organization: record.organization, owner: record.dao, agent: record.agent, scopes: record.scopes }) }));
    if (!filed) return true;
    json(res, 201, { request: publicDaoRequest(filed.record), transactions: filed.transactions }); return true;
  }
  const daoState = pathname.match(/^\/apps\/v1\/dao-consents\/([a-f0-9]{64})$/);
  if (daoState) {
    if (req.method !== "GET") { json(res, 405, { code: "invalid_request", error: "Use GET" }); return true; }
    const record = daoRequests.read(daoState[1]!);
    if (record?.kind !== "consent" || record.deployment !== credential.deployment || record.host !== host.toLowerCase()) { json(res, 404, { code: "not_found", error: "No such DAO consent request" }); return true; }
    const settled = record.consent && consents.list({ deployment: credential.deployment }).find(c => c.id === record.consent);
    if (settled) { json(res, 200, { state: "signed", consent: publicConsent(settled) }); return true; }
    // Ended before anything is read or recorded for it.
    if (endedByStop(record)) { stoppedAnswer(); return true; }
    const signature = await daoSignature(record, () => ({ state: "pending", request: publicDaoRequest(record) }));
    if (!signature) return true;
    const agent = selected.find(a => a.name === record.agent && reachable(a, credential.deployment, record.organization));
    const authority = agent && agent.owner === record.dao ? await resolveDaoAuthority(agent, daoOwner) : null;
    if (!authority || authority.agentId !== record.agentId || authority.signer.public_key !== record.signer.public_key) {
      json(res, 409, { code: "agent_changed", error: "The DAO signed, but the agent is no longer that DAO's agent with that identity. Nothing was stored." }); return true;
    }
    // The chain reads above wait: a stop applied meanwhile ends it too. The record is read again for its mark.
    if (endedByStop((daoRequests.read(record.id) ?? record) as DaoConsentRequest)) { stoppedAnswer(); return true; }
    const consent = daoConsent(record, signature);
    consents.admit(consent);
    if (stopping()) { json(res, 503, { error: "Gateway is stopping. Nothing was stored; read again." }); return true; }
    if (!stillAuthorized()) { json(res, 403, { code: "access_ended", error: "Access ended before storing. Nothing was stored." }); return true; }
    const stored = consents.store(consent);
    daoRequests.settle(record.id, stored.id);
    appendSynced(accessLog(ROOT), { at: new Date().toISOString(), deployment: credential.deployment, credential: credential.id,
      event: "consent", signer: "dao", request: record.id, consent: stored.id, organization: stored.organization, owner: stored.owner, agent: stored.agent, scopes: stored.scopes });
    json(res, 200, { state: "signed", consent: publicConsent(stored) }); return true;
  }

  // A DAO's hosted Treasury agent, set up by its vote: the platform reserves it once the DAO's signature over the setup
  // text is found, and stores a setup consent that lets the app ask for the agent's creation, a second vote.
  if (pathname === "/apps/v1/dao-setups") {
    if (req.method !== "POST") { json(res, 405, { code: "invalid_request", error: "Use POST" }); return true; }
    if (!options.setup) { json(res, 403, { code: "setup_unavailable", error: "Agent setup isn't available on this host" }); return true; }
    const body = daoConsentFiling.safeParse(await readJson(req));
    if (!body.success) { json(res, 400, { code: "invalid_request", error: "Send the canonical setup text as message." }); return true; }
    const { text, expiresAt } = verifyDaoSetupText(body.data.message, { host, deployment: credential.deployment });
    // A vote takes the DAO's time: refuse here what the host could never reserve, before anything is filed.
    if (!options.setupAreas?.includes(text.area)) { json(res, 403, { code: "setup_unavailable", error: `This host doesn't set up ${text.area} agents. Nothing was filed.` }); return true; }
    let policy: Awaited<ReturnType<DaoOwnerReads["policy"]>>, signer: Awaited<ReturnType<DaoOwnerReads["owner"]>>;
    try { policy = await daoOwner.policy(text.owner); signer = policy ? await daoOwner.owner(text.owner) : undefined as never; }
    catch { throw new AuthorityUnanswered(); }
    if (!policy) { json(res, 409, { code: "not_dao", error: "The setup's owner isn't a Sputnik DAO. A wallet owner signs /apps/v1/setup. Nothing was filed." }); return true; }
    const filed = daoFiled(await daoRequests.file({ kind: "setup", deployment: credential.deployment, host: text.host, organization: text.organization,
      dao: text.owner, agent: "", agentId: UNBORN, area: text.area, expiresAt, message: body.data.message,
      signer: { account_id: signer.account_id, public_key: signer.public_key } }, { bond: policy.proposal_bond, stopping,
      log: record => ({ deployment: credential.deployment, credential: credential.id, event: "dao-setup-filed", request: record.id,
        organization: record.organization, owner: record.dao, area: record.area }) }));
    if (!filed) return true;
    json(res, 201, { request: publicDaoSetup(filed.record), transactions: filed.transactions }); return true;
  }
  const setupState = pathname.match(/^\/apps\/v1\/dao-setups\/([a-f0-9]{64})$/);
  if (setupState) {
    if (req.method !== "GET") { json(res, 405, { code: "invalid_request", error: "Use GET" }); return true; }
    const record = daoRequests.read(setupState[1]!);
    if (record?.kind !== "setup" || record.deployment !== credential.deployment || record.host !== host.toLowerCase()) { json(res, 404, { code: "not_found", error: "No such DAO setup request" }); return true; }
    const stored = record.consent && consents.list({ deployment: credential.deployment }).find(c => c.id === record.consent);
    if (stored && record.reserved) { json(res, 200, { state: "reserved", agent: record.reserved, consent: publicConsent(stored) }); return true; }
    if (!options.setup) { json(res, 403, { code: "setup_unavailable", error: "Agent setup isn't available on this host" }); return true; }
    const signature = await daoSignature(record, () => ({ state: "pending", request: publicDaoSetup(record) }));
    if (!signature) return true;
    // The DAO's derived key must still be the one it signed with: its policy and key are read again.
    let current: Awaited<ReturnType<DaoOwnerReads["owner"]>> | null;
    try { current = await daoOwner.policy(record.dao) ? await daoOwner.owner(record.dao) : null; } catch { throw new AuthorityUnanswered(); }
    if (current?.public_key !== record.signer.public_key) { json(res, 409, { code: "agent_changed", error: "The DAO signed, but its owner key changed. Nothing was set up." }); return true; }
    const consent = (agent: string) => daoSetupConsent(record, signature, agent);
    consents.admit(consent(""));
    if (stopping()) { json(res, 503, { error: "Gateway is stopping. Nothing was set up; read again." }); return true; }
    if (!stillAuthorized()) { json(res, 403, { code: "access_ended", error: "Access ended before setting up. Nothing was set up." }); return true; }
    const known = new Set(selected.map(a => a.name));
    let agent: AgentEntry;
    try { agent = await options.setup({ owner: record.dao, kind: "dao", area: record.area, deployment: credential.deployment, organization: record.organization }); }
    catch (error) { json(res, 409, { code: "setup_failed", error: error instanceof Error ? error.message : "The agent couldn't be set up" }); return true; }
    // A reservation found again may belong to a created agent, which a setup consent must never reach.
    if (known.has(agent.name)) {
      // Unanswered throws (503); null is an answer: the reserved agent isn't this DAO's now.
      const authority = await resolveDaoAuthority(agent, daoOwner);
      if (!authority) { json(res, 409, { code: "owner_changed", error: "The reserved agent isn't owned by this DAO's derived account now. Nothing was stored." }); return true; }
      if (authority.agentId !== null) { json(res, 409, { code: "already_created", error: "This DAO's agent for that area is already created. File the DAO's consent for it." }); return true; }
    }
    // Reserving and the re-read above wait: a credential revoked or a stop begun meanwhile stores nothing.
    if (stopping()) { json(res, 503, { error: "Gateway is stopping. Nothing was stored; read again." }); return true; }
    if (!stillAuthorized()) { json(res, 403, { code: "access_ended", error: "Access ended before storing. Nothing was stored." }); return true; }
    const saved = consents.store(consent(agent.name));
    daoRequests.reserved(record.id, saved.id, agent.name);
    appendSynced(accessLog(ROOT), { at: new Date().toISOString(), deployment: credential.deployment, credential: credential.id,
      event: "setup", signer: "dao", request: record.id, consent: saved.id, organization: saved.organization, owner: saved.owner, agent: agent.name, area: record.area });
    json(res, 200, { state: "reserved", agent: agent.name, consent: publicConsent(saved) }); return true;
  }

  // A DAO's vote on one of this app's Treasury proposals: the platform files it from the proposal's own text, and relays the
  // DAO's signature to the agent once found. The app never builds or sees a text the voters didn't read.
  if (pathname === "/apps/v1/dao-votes") {
    if (req.method !== "POST") { json(res, 405, { code: "invalid_request", error: "Use POST" }); return true; }
    const body = daoVoteFiling.safeParse(await readJson(req));
    if (!body.success) { json(res, 400, { code: "invalid_request", error: "Send organization, agent, proposal and verdict (approve or reject)." }); return true; }
    const { organization, agent: name, proposal: id, verdict } = body.data;
    const found = await daoTreasury(name, organization);
    if ("error" in found) { json(res, 403, found); return true; }
    const { agent, authority, consent, live } = found;
    let proposal: z.infer<typeof proposalView>;
    try { proposal = proposalView.parse(await agentCall(agent, credential.deployment, host, organization, consent.id, live).proposals.get({ id })); }
    catch { json(res, 409, { code: "proposal_unanswered", error: "The agent didn't answer this proposal for this app. Nothing was filed." }); return true; }
    if (proposal.state !== "proposed") { json(res, 409, { code: "proposal_not_open", error: `This proposal is ${proposal.state}; the DAO can't vote on it now. Nothing was filed.` }); return true; }
    // The vote must pass while both the proposal and the consent it is relayed under are live.
    const validUntil = Math.min(Date.parse(proposal.expiresAt), consent.expiresAt);
    if (!Number.isFinite(validUntil) || validUntil <= Date.now() + 60_000) { json(res, 409, { code: "expires_too_soon", error: "This proposal, or the consent it would be relayed under, expires too soon for a vote. Nothing was filed." }); return true; }
    const filed = daoFiled(await daoRequests.file({ kind: "proposal", deployment: credential.deployment, host: host.toLowerCase(), organization, dao: agent.owner,
      agent: name, agentId: consent.agentId, proposal: id, verdict, under: consent.id, expiresAt: validUntil, message: proposalText(proposal, verdict),
      signer: { account_id: authority.signer.account_id, public_key: authority.signer.public_key } }, { bond: authority.policy.proposal_bond, stopping,
      log: record => ({ deployment: credential.deployment, credential: credential.id, event: "dao-vote-filed", request: record.id,
        consent: consent.id, organization, owner: agent.owner, agent: name, proposal: id, verdict }) }));
    if (!filed) return true;
    json(res, 201, { request: publicDaoVote(filed.record), transactions: filed.transactions }); return true;
  }
  const voteState = pathname.match(/^\/apps\/v1\/dao-votes\/([a-f0-9]{64})$/);
  if (voteState) {
    if (req.method !== "GET") { json(res, 405, { code: "invalid_request", error: "Use GET" }); return true; }
    const record = daoRequests.read(voteState[1]!);
    if (record?.kind !== "proposal" || record.deployment !== credential.deployment || record.host !== host.toLowerCase()) { json(res, 404, { code: "not_found", error: "No such DAO vote request" }); return true; }
    if (record.relayed) { json(res, 200, { state: "relayed", request: publicDaoVote(record), proposalState: record.relayed.state }); return true; }
    const signature = await daoSignature(record, () => ({ state: "pending", request: publicDaoVote(record) }));
    if (!signature) return true;
    // The consent it was filed under must still be live, and the agent still the DAO's with that identity.
    const found = await daoTreasury(record.agent, record.organization);
    if ("error" in found || !found.live.includes(record.under)) {
      json(res, 409, { code: "consent_ended", error: "The DAO signed, but its consent for this app ended or the agent changed. Nothing was relayed." }); return true;
    }
    if (found.authority.signer.public_key !== record.signer.public_key || found.authority.agentId !== record.agentId) {
      json(res, 409, { code: "agent_changed", error: "The DAO signed, but the agent is no longer that DAO's agent with that identity. Nothing was relayed." }); return true;
    }
    if (stopping()) { json(res, 503, { error: "Gateway is stopping. Nothing was relayed; read again." }); return true; }
    if (!stillAuthorized() || !consents.live({ deployment: credential.deployment, host, organization: record.organization, agent: record.agent }).some(c => c.id === record.under)) {
      json(res, 403, { code: "access_ended", error: "Access ended before relaying. Nothing was relayed." }); return true;
    }
    const signed = { message: record.message, nonce: record.nonce, publicKey: record.signer.public_key, signature: signature.toString("base64") };
    const client = agentCall(found.agent, credential.deployment, host, record.organization, record.under, found.live).proposals;
    let answer: unknown;
    // Relaying the same signature again is answered with the proposal as it is: the agent keeps the first approval.
    try { answer = await (record.verdict === "approve" ? client.approve : client.reject)({ id: record.proposal, signed }); }
    catch (error) {
      // Refused while the proposal is open, the agent may take it later (`agent_refused`). Refused once the proposal is no
      // longer open, it never will: answered as filing answers it (`proposal_not_open`).
      const current = await client.get({ id: record.proposal }).then(read => proposalView.safeParse(read).data?.state, () => undefined);
      if (current !== undefined && current !== "proposed") {
        json(res, 409, { code: "proposal_not_open", error: `This proposal is ${current}; the DAO's ${record.verdict} can't apply to it. Nothing was relayed.` }); return true;
      }
      json(res, 409, { code: "agent_refused", error: `The agent refused the DAO's ${record.verdict}: ${error instanceof Error ? error.message : "refused"}. Reading again relays the same signature.` }); return true;
    }
    const relayed = daoRequests.relayed(record.id, proposalView.safeParse(answer).data?.state ?? "unknown");
    appendSynced(accessLog(ROOT), { at: new Date().toISOString(), deployment: credential.deployment, credential: credential.id,
      event: "dao-vote-relayed", request: record.id, consent: record.under, organization: record.organization, owner: record.dao, agent: record.agent,
      proposal: record.proposal, verdict: record.verdict });
    json(res, 200, { state: "relayed", request: publicDaoVote(relayed), proposalState: relayed.relayed!.state }); return true;
  }

  const revoke = pathname.match(/^\/apps\/v1\/consents\/([a-f0-9]{64})$/);
  if (revoke) {
    if (req.method !== "DELETE") { json(res, 405, { code: "invalid_request", error: "Use DELETE" }); return true; }
    if (!consents.revoke(revoke[1]!, { deployment: credential.deployment, host })) { json(res, 404, { code: "not_found", error: "No such consent" }); return true; }
    appendSynced(accessLog(ROOT), { at: new Date().toISOString(), deployment: credential.deployment, credential: credential.id, event: "revoke", consent: revoke[1] });
    json(res, 200, { revoked: true }); return true;
  }

  const call = pathname.match(/^\/apps\/v1\/o\/([A-Za-z0-9_-]{1,128})\/a\/([a-z0-9-]{1,32})\/rpc\/([A-Za-z][A-Za-z0-9]*(?:\/[A-Za-z][A-Za-z0-9]*)*)$/);
  if (!call) { json(res, 404, { code: "not_found", error: "Not found" }); return true; }
  if (req.method !== "POST") { json(res, 405, { code: "invalid_request", error: "Use POST" }); return true; }
  const [, organization, name, path] = call as unknown as [string, string, string, string];
  const agent = selected.find(a => a.name === name && reachable(a, credential.deployment, organization));
  const live = agent ? consents.live({ deployment: credential.deployment, host, organization, agent: name }).filter(c => c.owner === agent.owner) : [];
  // The scope check below would refuse this too; refusing here spares the ownership lookup's provider and chain reads.
  if (!agent || !live.length) { json(res, 403, { code: "no_consent", access: "agent", error: "No live owner consent covers this Organization and agent" }); return true; }
  const input = await readJson(req);
  // A DAO's consents answer to the DAO's derived account now, re-read on every call; a wallet's to the wallet's.
  const byDao = live.some(c => c.signer === "dao");
  // Through an app, an owner's wallet signs only what it can read or what the platform built entirely; a DAO votes only on
  // `DAO_APP_ACTIONS` (a Treasury grant, its revocation, a policy edit, freeze or unfreeze), which the platform
  // prepares and files as its proposal.
  const prepared = path === "owner/prepare" ? (byDao ? appMayPrepareForDao(input) : appMayPrepare(input)) : undefined;
  if (prepared === null) {
    json(res, 403, { code: "not_allowed", access: "procedure", error: byDao ? "Through an app, a DAO (signer \"dao\") votes only on a Treasury grant, its revocation, a policy edit, freeze and unfreeze."
      : "Through an app, the owner's wallet (signer \"wallet\") signs only: agent creation without payees, freeze, " +
      "unfreeze, grants, policy edits and votes on held payouts." }); return true;
  }
  // An action held for the confirm page is signed and submitted there only; an unreadable body is the agent's to refuse.
  const submitted = path === "owner/submit" ? submittedCorrelation(input) : null;
  if (submitted !== null && confirms.holds(submitted)) {
    json(res, 403, { code: "confirm_page", access: "procedure", error: "This owner action is signed on the platform's confirm page, not through the app." }); return true;
  }
  const body = JSON.stringify(input);
  const authority = byDao ? await resolveDaoAuthority(agent, daoOwner) : await resolveWalletAuthority(agent.owner, agent);
  if (!authority) { json(res, 403, { code: "owner_changed", access: "agent", error: "The agent's owner isn't the one this app's consents name now. Nothing was forwarded." }); return true; }
  // A setup consent (UNBORN) acts only while the agent isn't created; afterwards it may still follow the creation it
  // relayed (status reads), and nothing else. Any other consent matches only the agent it names.
  const matches = (c: ConsentRecord) => (c.signer === "dao") === byDao && (c.agentId === (authority.agentId ?? UNBORN) ||
    (c.agentId === UNBORN && authority.agentId !== null && FOLLOW_CREATION.has(path)));
  // A DAO's treasury consent also covers preparing the owner actions it votes on (checked above).
  const covers = (c: ConsentRecord) => byDao
    ? (mayCall(authority.access, path) && daoScopesCover(c.scopes, path) && path !== "owner/prepare")
      || (prepared !== undefined && (c.agentId === UNBORN ? prepared.type === "agent_create" : prepared.type !== "agent_create" && c.scopes.includes("treasury")))
    : appMayCall(c.scopes, authority.access, path);
  const named = live.filter(matches);
  if (!named.length) { json(res, 403, { code: "agent_changed", access: "agent", error: "No live consent names this agent's current identity: it was replaced or created since. Ask the owner to sign a consent for it." }); return true; }
  const consent = named.find(covers);
  if (!consent) { json(res, 403, { code: "scope", access: "procedure", error: "No live consent's scopes cover this procedure" }); return true; }
  // Removing a key is how an owner answers its compromise: the chain saying so ends the consent for good. A failed
  // lookup refuses this call only. A DAO's derived key can't be removed; its ownership was re-checked above.
  let holds = true;
  if (!byDao) {
    try { holds = await consentKeyHolds(consents, consent, keyState); }
    catch { json(res, 503, { error: "The consent's signing key couldn't be checked. Nothing was forwarded; reading again is safe." }); return true; }
  }
  // The re-check before forwarding would also refuse this call (the consent is now revoked); refusing here says why.
  if (!holds) { json(res, 403, { code: "consent_revoked", access: "agent", error: "The key that signed this consent was removed from its owner's account, so the consent was revoked" }); return true; }
  // The owner key a created agent answers to is the one that signed (and was checked full-access for) this consent.
  if (!byDao && prepared?.type === "agent_create" && prepared.owner?.public_key !== consent.publicKey) {
    json(res, 403, { code: "setup_key", access: "procedure", error: "Create the agent with the key that signed the setup" }); return true;
  }
  // An owner's approval or rejection of a proposal: the platform checks it is the owner's, for this host, before the agent
  // compares its text with the proposal's.
  if (path === "proposals/approve" || path === "proposals/reject") {
    const problem = await proposalSignatureProblem(input, host, agent.owner, lookup);
    if (problem) { json(res, 400, { code: "signature_invalid", error: `${problem} Nothing was recorded.` }); return true; }
  }
  // The checks above waited on the chain: a stop begun meanwhile answers 503; a credential or consent revoked, 403.
  if (stopping()) { json(res, 503, { error: "Gateway is stopping. Nothing was forwarded." }); return true; }
  if (!credentials.authenticate(req.headers.authorization, host) ||
    !consents.live({ deployment: credential.deployment, host, organization, agent: name }).some(c => c.id === consent.id)) {
    json(res, 403, { code: "access_ended", access: "agent", error: "Access ended before forwarding" }); return true;
  }
  appendSynced(accessLog(ROOT), { at: new Date().toISOString(), deployment: credential.deployment, credential: credential.id,
    event: "call", consent: consent.id, organization, owner: agent.owner, agent: name, agentId: authority.agentId, path });
  // A readable (NEP-413) intent goes to the app: its text is one the owner's wallet can show. A NEP-366 intent is held here for the
  // owner to sign on the platform's confirm page; the app gets the link, not the bytes. Anything else isn't released.
  const release = prepared && ((reply: unknown) => {
    const raw = reply as { json?: unknown; meta?: unknown };
    const output = ownerPrepareOutput.safeParse(raw.json);
    const standard = output.success ? output.data.intent?.standard : undefined;
    if (standard === "nep413" && !byDao) return null;
    const log = (event: string) => appendSynced(accessLog(ROOT), { at: new Date().toISOString(), deployment: credential.deployment,
      credential: credential.id, event, consent: consent.id, organization, owner: agent.owner, agent: name, action: prepared.type,
      correlationId: (raw.json as { correlationId?: unknown } | undefined)?.correlationId ?? null });
    // A DAO's action comes back as the proposal its members file, never as an intent the app could have signed elsewhere.
    if (byDao) {
      if (output.success && !output.data.intent && !output.data.signer && output.data.dao) { log("dao-vote-prepared"); return null; }
      log("withheld");
      return "This owner action came back in a form the platform can't file for the DAO's vote. It wasn't released and expires unsigned.";
    }
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
