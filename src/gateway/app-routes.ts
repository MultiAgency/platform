import { releaseInput, appReleaseOutput } from "../contract/agent-release.js";
import type { HostedAgents } from "./hosted-agents.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { daoPolicy } from "../chain.js";
import { proposalTransaction } from "../dao-owner.js";
import type { z } from "zod";
import type { Area } from "../contract/areas.js";
import { readJson, sendJson as json } from "../http.js";
import { chainKeyState, hourlyLimit, type KeyLookup, type KeyStateLookup } from "../signin.js";
import { appendSynced } from "../synced.js";
import type { AgentEntry } from "./config.js";
import { daoMarketMayAsk, daoPayoutMayAsk, daoScopesCover } from "../contract/app-access.js";
import { ownerPrepareOutput } from "../contract/owner-outputs.js";
import { mayCall } from "./allowlist.js";
import { accessLog, consentKeyHolds, AppConsents, AppCredentials, appMayCall, DEFAULT_REQUESTS_PER_HOUR, appMayPrepare, appMayPrepareForDao, proposalSignatureProblem, setupConsent, submittedCorrelation, UNBORN, verifyConsent, verifySetup, type ConsentRecord } from "./app-access.js";
import { AppConfirms } from "./app-confirm.js";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { proposalText, proposalView } from "../contract/treasury-proposals.js";
import { limitOrderText, limitOrderView } from "../contract/limit-orders.js";
import { hireText, marketApproveInput, MAX_HIRE_APPROVAL_MS } from "../contract/market.js";
import { marketHireOutput } from "../contract/owner-outputs.js";
import { createHash } from "node:crypto";
import type { Router } from "../router.js";
import { agentOrigin } from "./agent-origin.js";
import { chainDaoVotes, daoConsent, type DaoConsentRequest, type DaoFiled, type DaoRequest, DaoHireFilingUnavailable, DaoRequests, daoSetupConsent, type DaoVotes, publicDaoHire, publicDaoOrder, publicDaoRequest, publicDaoSetup, publicDaoVote, verifyDaoConsentText, verifyDaoSetupText } from "./app-dao.js";
import { AuthorityUnanswered, chainDaoOwner, type DaoOwnerReads, resolveDaoAuthority, resolveWalletAuthority } from "./machine-authority.js";
import { forwardRpc } from "./rpc-proxy.js";
import { issueNonce, nonceIssuedAt } from "./consent-nonce.js";
import { walletStopCutoff } from "./wallet-stop.js";
import { fairShare, type Decision } from "./fair-share.js";
import { reservationQuery, daoConsentFiling, daoHireFiling, daoVoteFiling, daoOrderFiling } from "./app-inputs.js";

const ROOT = ".app-access";
class AppAccessEnded extends Error {}
const credentials = new AppCredentials(ROOT), consents = new AppConsents(ROOT);
export const confirms = new AppConfirms(ROOT);
export const APP_ROOT = ROOT;
/** Each credential's requests in the hour, held to its own limit (`perHour`, which the operator sets). */
const mayUse = hourlyLimit(DEFAULT_REQUESTS_PER_HOUR);
/**
 * Calls on the path of an owner's or a DAO's signature with a short window (a setup, a consent and the nonce asked just
 * before it is signed, an owner action's submission, and the DAO request reads that relay a passed vote's signature). They draw on a budget of their
 * own, the same size as the credential's: ordinary traffic can't use it up and waste a signature, and they still can't
 * be used to get around the limit (#59).
 */
const SIGNED = /^\/apps\/v1\/(?:setup|consents|consent-nonces|o\/[A-Za-z0-9_-]{1,128}\/a\/[a-z0-9-]{1,32}\/rpc\/(?:owner\/submit|limitOrders\/(?:approve|reject)))$/;
const RELAYS = /^\/apps\/v1\/dao-(?:setups|consents|votes|hires|limit-orders)\/[a-f0-9]{64}$/;
const budgetOf = (method: string | undefined, pathname: string) =>
  method === "POST" && SIGNED.test(pathname) || method === "GET" && RELAYS.test(pathname) ? "signed" as const : "shared" as const;
/** The shared budget, with a slice kept for each other Organization seen this hour (#59, `fair-share.ts`). */
const share = fairShare();
/** When each credential's budget last logged a 429: at most one line a minute, so a flood can't grow the log. */
const limitLogged = new Map<string, number>();
const publicConsent = ({ message: _m, nonce: _n, signature: _s, ...record }: ConsentRecord) => record;

const FOLLOW_CREATION = new Set(["owner/status", "owner/actions", "owner/pending"]);
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
export type HostedSetup = (input: { owner: string; kind: "wallet" | "dao"; area: Area; deployment: string; organization: string }) => Promise<AgentEntry>;
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
  setupAreas?: readonly string[];
  /** The gateway's secret, from which consent nonces are signed (`consent-nonce.ts`). Without it none is issued or recognised. */
  nonceSecret?: string; hosted?: HostedAgents; stopHosted?: (name: string) => Promise<void> };

export async function appRoutes(req: IncomingMessage, res: ServerResponse, pathname: string, host: string,
  selected: AgentEntry[], stopping: () => boolean, options: AppRouteOptions = {}): Promise<boolean> {
  if (!pathname.startsWith("/apps/")) return false;
  try { return await route(req, res, pathname, host, selected, stopping, options); }
  catch (error) {
    if (error instanceof AppAccessEnded) {
      if (res.headersSent) res.destroy();
      else json(res, 403, { code: "access_ended", error: "App access ended before filing. Nothing was filed." });
      return true;
    }
    if (error instanceof DaoHireFilingUnavailable) {
      if (res.headersSent) res.destroy();
      else json(res, 503, { error: error.message });
      return true;
    }
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
  const budget = budgetOf(req.method, pathname), key = `${credential.id}:${budget}`;
  const pathOrganization = pathname.match(/^\/apps\/v1\/o\/([A-Za-z0-9_-]{1,128})\//)?.[1] ?? null;
  const decision: Decision = budget === "shared" ? share.allow(credential.id, pathOrganization, now, credential.perHour)
    : mayUse(key, now, credential.perHour) ? { allowed: true }
    : { allowed: false, reason: "limit", retryAfterSeconds: mayUse.retryAfterSeconds(key, now, credential.perHour) };
  if (!decision.allowed) {
    if (now - (limitLogged.get(key) ?? 0) >= 60_000) {
      if (limitLogged.size > 10_000) limitLogged.clear();
      limitLogged.set(key, now);
      appendSynced(accessLog(ROOT), { at: new Date(now).toISOString(), deployment: credential.deployment, credential: credential.id,
        event: "rate_limited", budget, reason: decision.reason, organization: pathOrganization });
    }
    const after = decision.retryAfterSeconds;
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
    if (followed.state === "expired") json(res, 410, { code: "signed_expired", error: record.kind === "hire"
      ? `What the DAO signed expired at ${new Date(record.expiresAt).toISOString()}. Prior funding may remain on the payment key. Inspect market/status for requestId ${record.requestId}, then file a fresh vote with the same terms and same requestId.`
      : `What the DAO signed expired at ${new Date(record.expiresAt).toISOString()}. Nothing was done; file it again.` });
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
  /**
   * The owner's wallet stop covering this agent ends texts signed before it: after it, a text counts only if this platform
   * issued its nonce later. Checked with no wait before storing, so a stop applying meanwhile either finds the consent
   * stored (and ends it) or is found here.
   */
  const signedBeforeStop = (owner: string, agent: string | undefined, nonce: string) => {
    const stoppedAt = walletStopCutoff(ROOT, { host, owner, agent });
    const releasedAt = agent === undefined ? [] : (options.hosted?.releases() ?? []).filter(r => r.name === agent && r.owner === owner).map(r => Date.parse(r.at));
    const cutoff = Math.max(stoppedAt ?? -Infinity, ...releasedAt);
    if (cutoff === -Infinity) return false;
    const issued = options.nonceSecret ? nonceIssuedAt(options.nonceSecret, { host, deployment: credential.deployment }, nonce) : null;
    return issued === null || issued <= cutoff;
  };
  const ownerStopped = () => json(res, 409, { code: "owner_stopped", error: "The owner stopped or released this agent, and this text may have been signed before that. Nothing was stored; ask the platform for a consent nonce and ask the owner to sign the text with it." });
  const stoppedAnswer = () => json(res, 409, { code: "dao_stopped", error: "The DAO stopped this agent after this consent was filed. Nothing was stored; file a new consent for the DAO's vote." });
  // Capability discovery is credentialed but grants no owner authority. It names only app routes this host can serve,
  // not an active agent release, the provider's deployed routes, or a live consent.
  if (pathname === "/apps/v1/capabilities") {
    if (req.method !== "GET") { json(res, 405, { code: "invalid_request", error: "Use GET" }); return true; }
    const treasury = options.setupAreas?.includes("treasury") || selected.some(a => a.area === "treasury" && reachable(a, credential.deployment));
    // Every agent of this host answers `deposit` under a `requestId` and `depositStatus` (deposit-requests.ts).
    json(res, 200, { capabilities: ["deposit-requests-v1", ...(treasury ? ["treasury-limit-orders-v1"] : [])] }); return true;
  }
  /** A DAO's agent for this app and Organization, with live DAO consents carrying the requested scope. Orders need both Treasury scopes. */
  const daoAgent = async (name: string, organization: string, scope: "treasury" | "treasury-orders" | "market" = "treasury") => {
    const agent = selected.find(a => a.name === name && reachable(a, credential.deployment, organization));
    if (!agent) return { code: "no_consent", error: "This host has no such agent for this app and Organization" };
    const authority = await resolveDaoAuthority(agent, daoOwner);
    if (!authority) return { code: "owner_changed", error: "This agent isn't owned by a DAO's derived account now" };
    if (authority.agentId === null) return { code: "not_created", error: "This DAO's agent isn't created yet" };
    const covering = consents.live({ deployment: credential.deployment, host, organization, agent: name })
      .filter(c => c.signer === "dao" && c.owner === agent.owner && c.agentId === authority.agentId && c.scopes.includes(scope)
        && (scope !== "treasury-orders" || c.scopes.includes("treasury")));
    if (!covering.length) return { code: "no_consent", error: `No live DAO consent with ${scope} covers this Organization and agent` };
    // The longest-lived one, so a vote filed under it has the most time to pass.
    const consent = covering.reduce((best, c) => c.expiresAt > best.expiresAt ? c : best);
    return { agent, authority, consent, live: covering.map(c => c.id) };
  };

  // The agents this deployment's setups reserved for an Organization, as the registry records them: how an app whose
  // setup reply was lost learns the name once the signed setup has expired. Only reservations it caused; no chain read.
  if (pathname === "/apps/v1/agents") {
    if (req.method !== "GET") { json(res, 405, { code: "invalid_request", error: "Use GET" }); return true; }
    const query = reservationQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success) { json(res, 400, { code: "invalid_request", error: "Name the organization, and optionally the owner and area (treasury or payables)." }); return true; }
    const { organization, owner, area } = query.data;
    const agents = selected.flatMap(a => {
      const scope = a as AgentEntry & { deployment?: string; organization?: string };
      return scope.deployment === credential.deployment && scope.organization === organization && a.area !== undefined
        && (owner === undefined || a.owner === owner) && (area === undefined || a.area === area)
        ? [{ agent: a.name, organization, owner: a.owner, area: a.area }] : [];
    });
    for (const r of options.hosted?.releases() ?? []) {
      if (r.state === "restored" || r.deployment !== credential.deployment || r.organization !== organization ||
        (owner !== undefined && r.owner !== owner) || (area !== undefined && r.area !== area)) continue;
      const existing = agents.findIndex(a => a.agent === r.name);
      if (existing >= 0) agents.splice(existing, 1);
      agents.push({ agent: r.name, organization, owner: r.owner, area: r.area, released: true } as typeof agents[number]);
    }
    json(res, 200, { agents }); return true;
  }

  const target = pathname.match(/^\/apps\/v1\/(?:agents\/([a-z0-9-]{1,32})|o\/([A-Za-z0-9_-]{1,128})\/a\/([a-z0-9-]{1,32})\/rpc\/)/);
  const gone = target && options.hosted?.released(target[1] ?? target[3]!);
  if (gone && gone.deployment === credential.deployment && (target[2] === undefined || gone.organization === target[2])) {
    json(res, 410, { code: "agent_released", error: "This agent's hosted reservation was released. Its owner must sign a fresh setup with a platform-issued nonce to restore it." }); return true;
  }

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
    // Whether its consent can be stored, before reserving anything for it: a stop for every agent covers one not reserved yet.
    consents.admit(setupConsent(verified, "pending"));
    if (signedBeforeStop(verified.setup.owner, undefined, verified.signed.nonce)) { ownerStopped(); return true; }
    const lastRelease = options.hosted?.releases().findLast(r => r.deployment === credential.deployment && r.organization === verified.setup.organization &&
      r.owner === verified.setup.owner && r.area === verified.setup.area);
    if (lastRelease) {
      const issued = options.nonceSecret ? nonceIssuedAt(options.nonceSecret, { host, deployment: credential.deployment }, verified.signed.nonce) : null;
      if (issued === null || issued <= Date.parse(lastRelease.at)) { ownerStopped(); return true; }
    }
    const known = new Set(selected.filter(a => !options.hosted?.released(a.name)).map(a => a.name));
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
    if (signedBeforeStop(verified.setup.owner, agent.name, verified.signed.nonce)) { ownerStopped(); return true; }
    const record = consents.store(setupConsent(verified, agent.name));
    appendSynced(accessLog(ROOT), { at: new Date().toISOString(), deployment: credential.deployment, credential: credential.id,
      event: "setup", consent: record.id, organization: record.organization, owner: record.owner, agent: record.agent, area: verified.setup.area });
    json(res, 201, { agent: agent.name, consent: publicConsent(record) }); return true;
  }

  if (pathname === "/apps/v1/consent-nonces") {
    if (req.method !== "POST") { json(res, 405, { code: "invalid_request", error: "Use POST" }); return true; }
    if (!options.nonceSecret) { json(res, 503, { error: "This host issues no consent nonces." }); return true; }
    json(res, 200, issueNonce(options.nonceSecret, { host, deployment: credential.deployment })); return true;
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
    if (signedBeforeStop(verified.owner, agent.name, verified.nonce)) { ownerStopped(); return true; }
    if (options.hosted?.released(agent.name)) { json(res, 410, { code: "agent_released", error: "This agent was released while the consent was checked. Nothing was stored." }); return true; }
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
    const found = record.consent ? consents.find(record.consent) : null;
    const settled = found?.deployment === credential.deployment ? found : null;
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
    const found = record.consent ? consents.find(record.consent) : null;
    const stored = found?.deployment === credential.deployment ? found : null;
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
    const found = await daoAgent(name, organization);
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
    const found = await daoAgent(record.agent, record.organization);
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

  // A DAO signs one exact proposed order under a consent carrying both Treasury scopes. The vote only approves or
  // rejects the immutable terms; the agent's guarded placement is a separate operation.
  if (pathname === "/apps/v1/dao-limit-orders") {
    if (req.method !== "POST") { json(res, 405, { code: "invalid_request", error: "Use POST" }); return true; }
    const body = daoOrderFiling.safeParse(await readJson(req));
    if (!body.success) { json(res, 400, { code: "invalid_request", error: "Send organization, agent, order and verdict (approve or reject)." }); return true; }
    const { organization, agent: name, order: id, verdict } = body.data;
    const found = await daoAgent(name, organization, "treasury-orders");
    if ("error" in found) { json(res, 403, found); return true; }
    const { agent, authority, consent, live } = found;
    let order: z.infer<typeof limitOrderView>;
    try { order = limitOrderView.parse(await agentCall(agent, credential.deployment, host, organization, consent.id, live).limitOrders.get({ id })); }
    catch { json(res, 409, { code: "order_unanswered", error: "The agent didn't answer this order for this app. Nothing was filed." }); return true; }
    if (order.id !== id || order.deployment !== credential.deployment || order.organization !== organization || order.agentId !== consent.agentId) {
      json(res, 409, { code: "order_unanswered", error: "The agent's order is not this app's proposed order. Nothing was filed." }); return true;
    }
    if (order.state !== "proposed") { json(res, 409, { code: "order_not_open", error: `This order is ${order.state}; the DAO can't vote on it now. Nothing was filed.` }); return true; }
    const validUntil = Math.min(Date.parse(order.expiresAt), Date.parse(order.order.deadline), consent.expiresAt);
    if (!Number.isFinite(validUntil) || validUntil <= Date.now() + 60_000) {
      json(res, 409, { code: "expires_too_soon", error: "This order, or the consent it would be relayed under, expires too soon for a vote. Nothing was filed." }); return true;
    }
    const mayFileOrderVote = () => stillAuthorized() && consents.live({ deployment: credential.deployment, host, organization, agent: name })
      .some(c => c.id === consent.id && c.scopes.includes("treasury") && c.scopes.includes("treasury-orders"));
    const filedResult = await daoRequests.file({ kind: "limit_order", deployment: credential.deployment, host: host.toLowerCase(), organization,
      dao: agent.owner, agent: name, agentId: consent.agentId, order: id, verdict, under: consent.id, expiresAt: validUntil,
      message: limitOrderText(order, verdict), signer: { account_id: authority.signer.account_id, public_key: authority.signer.public_key } },
      { bond: authority.policy.proposal_bond, stopping: () => stopping() || !mayFileOrderVote(),
        log: record => ({ deployment: credential.deployment, credential: credential.id, event: "dao-order-filed", request: record.id,
          consent: consent.id, organization, owner: agent.owner, agent: name, order: id, verdict }) });
    if (!mayFileOrderVote()) { json(res, 403, { code: "access_ended", error: "Access ended before this DAO vote was filed. Nothing was stored." }); return true; }
    const filed = daoFiled(filedResult);
    if (!filed) return true;
    json(res, 201, { request: publicDaoOrder(filed.record), transactions: filed.transactions }); return true;
  }
  const orderVoteState = pathname.match(/^\/apps\/v1\/dao-limit-orders\/([a-f0-9]{64})$/);
  if (orderVoteState) {
    if (req.method !== "GET") { json(res, 405, { code: "invalid_request", error: "Use GET" }); return true; }
    const record = daoRequests.read(orderVoteState[1]!);
    if (record?.kind !== "limit_order" || record.deployment !== credential.deployment || record.host !== host.toLowerCase()) {
      json(res, 404, { code: "not_found", error: "No such DAO limit-order vote" }); return true;
    }
    if (record.relayed) { json(res, 200, { state: "relayed", request: publicDaoOrder(record), orderState: record.relayed.state }); return true; }
    const signature = await daoSignature(record, () => ({ state: "pending", request: publicDaoOrder(record) }));
    if (!signature) return true;
    const found = await daoAgent(record.agent, record.organization, "treasury-orders");
    if ("error" in found || !found.live.includes(record.under)) {
      json(res, 409, { code: "consent_ended", error: "The DAO signed, but its order consent for this app ended or the agent changed. Nothing was relayed." }); return true;
    }
    if (found.authority.signer.public_key !== record.signer.public_key || found.authority.agentId !== record.agentId) {
      json(res, 409, { code: "agent_changed", error: "The DAO signed, but the agent is no longer that DAO's agent with that identity. Nothing was relayed." }); return true;
    }
    if (stopping()) { json(res, 503, { error: "Gateway is stopping. Nothing was relayed; read again." }); return true; }
    if (!stillAuthorized() || !consents.live({ deployment: credential.deployment, host, organization: record.organization, agent: record.agent })
      .some(c => c.id === record.under && c.scopes.includes("treasury") && c.scopes.includes("treasury-orders"))) {
      json(res, 403, { code: "access_ended", error: "Access ended before relaying. Nothing was relayed." }); return true;
    }
    const signed = { message: record.message, nonce: record.nonce, publicKey: record.signer.public_key, signature: signature.toString("base64") };
    const client = agentCall(found.agent, credential.deployment, host, record.organization, record.under, found.live).limitOrders;
    const signedHash = createHash("sha256").update(signed.signature).digest("hex");
    const relay = daoRequests.claimOrderRelay(record.id, signedHash);
    if (relay === "mismatch") {
      json(res, 409, { code: "signature_changed", error: "A different DAO signature was already claimed for this order vote. Reconcile the saved attempt before taking any action." }); return true;
    }
    let answer: unknown;
    if (relay === "claimed") {
      try { answer = await (record.verdict === "approve" ? client.approve : client.reject)({ id: record.order, signed }); }
      catch { /* The claimed outcome is unknown. Read the agent receipt; never submit this signature again. */ }
    }
    if (answer === undefined) answer = await client.get({ id: record.order }).catch(() => undefined);
    const accepted = limitOrderView.safeParse(answer);
    const read = accepted.success ? accepted.data : null;
    const applied = read && read.id === record.order && read.agentId === record.agentId &&
      read.deployment === record.deployment && read.organization === record.organization &&
      (record.verdict === "approve"
        ? read.approvalSignatureHash === signedHash && !["proposed", "rejected", "withdrawn"].includes(read.state)
        : read.rejectionSignatureHash === signedHash && read.state === "rejected");
    if (!applied) {
      json(res, 409, { code: "relay_unresolved", error: "The agent did not prove this exact DAO verdict was recorded. Poll this vote again; its saved signature will not be submitted again." }); return true;
    }
    const relayed = daoRequests.orderRelayed(record.id, read.state);
    appendSynced(accessLog(ROOT), { at: new Date().toISOString(), deployment: credential.deployment, credential: credential.id,
      event: "dao-order-relayed", request: record.id, consent: record.under, organization: record.organization, owner: record.dao,
      agent: record.agent, order: record.order, verdict: record.verdict });
    json(res, 200, { state: "relayed", request: publicDaoOrder(relayed), orderState: relayed.relayed!.state }); return true;
  }

  // A DAO's approval of one market hire (docs/market.md): the platform files it from its own text of the hire's terms, and
  // relays the DAO's signature to the agent, which checks the key is its DAO owner's and then pays the hire once.
  if (pathname === "/apps/v1/dao-hires") {
    if (req.method !== "POST") { json(res, 405, { code: "invalid_request", error: "Use POST" }); return true; }
    const body = daoHireFiling.safeParse(await readJson(req));
    if (!body.success) { json(res, 400, { code: "invalid_request", error: "Send organization, agent, requestId, brief, approved (a market/quote answer) and validUntil." }); return true; }
    const { organization, agent: name, requestId, brief, approved, validUntil, recoverProposal } = body.data;
    if (createHash("sha256").update(brief).digest("hex") !== approved.brief) { json(res, 400, { code: "brief_mismatch", error: "The brief isn't the one these terms were quoted for. Nothing was filed." }); return true; }
    await daoRequests.withHireFiling(credential.deployment, organization, name, requestId, async assertHeld => {
      // Re-read the owner and live consent after waiting for another filer. The lock also covers the disk lookup below.
      const found = await daoAgent(name, organization, "market");
      if ("error" in found) { json(res, 403, found); return; }
      const { agent, authority, consent } = found;
      const accessLive = () => stillAuthorized() && consents.live({ deployment: credential.deployment, host, organization, agent: name }).some(c => c.id === consent.id);
      if (!accessLive()) { json(res, 403, { code: "access_ended", error: "App access ended before filing. Nothing was filed." }); return; }
      // An earlier filing with other terms refuses. A relayed request, or a live signed approval or vote, is answered
      // again without filing. Funding may outlive approval, so an expired unrelayed request may get a fresh vote.
      const earlier = daoRequests.hires(credential.deployment, organization, name, requestId);
      if (earlier.some(r => r.brief !== brief || JSON.stringify(r.approved) !== JSON.stringify(approved))) {
        json(res, 409, { code: "request_conflict", error: "This requestId was already filed with other terms. Nothing was filed." }); return;
      }
      const filingNow = Date.now();
      const current = earlier.find(r => r.relayed !== null ||
        (r.expiresAt > filingNow && (Boolean(r.signature) || r.votingUntil > filingNow)));
      if (current) {
        // A lost 201 may leave the app without the member's transaction. Legacy callers still get null: recovering
        // a signable proposal requires an explicit request after the app checks the DAO for prior submission.
        // A signed/relayed request gets no transaction, and old records without the original bond fail closed.
        let proposal = null;
        if (recoverProposal && !current.relayed && !current.signature && current.votingUntil > filingNow && current.expiresAt > filingNow) {
          const originalConsentLive = () => consents.live({ deployment: credential.deployment, host,
            organization, agent: name }).some(c => c.id === current.under);
          if (current.host !== host.toLowerCase() || !originalConsentLive()) {
            json(res, 409, { code: "consent_ended", error: "The original DAO hire consent or host is no longer live. No proposal was returned." }); return;
          }
          if (current.dao !== agent.owner || current.agentId !== authority.agentId ||
              current.signer.account_id !== authority.signer.account_id ||
              current.signer.public_key !== authority.signer.public_key) {
            json(res, 409, { code: "agent_changed", error: "The DAO hire's original agent or signer changed. No proposal was returned." }); return;
          }
          const originalBond = daoRequests.hireProposalBond(current.id);
          const followed = await daoRequests.follow(current);
          // A credential, consent or filing lock can end during the chain read. Never return a signable proposal
          // to a caller that lost access while we checked whether the original proposal was submitted.
          assertHeld();
          if (!accessLive()) throw new AppAccessEnded();
          if (!originalConsentLive()) {
            json(res, 409, { code: "consent_ended", error: "The original DAO hire consent ended during the chain read. No proposal was returned." }); return;
          }
          if (followed.state === "unreadable") {
            json(res, 503, { error: "The DAO's vote couldn't be checked now. Retry the same requestId and terms." }); return;
          }
          const latest = daoRequests.read(current.id);
          const afterRead = Date.now();
          if (followed.state === "pending" && originalBond !== null && latest?.kind === "hire" &&
              !latest.signature && !latest.relayed && latest.votingUntil > afterRead && latest.expiresAt > afterRead)
            proposal = proposalTransaction(latest.dao, latest.id, latest.description, originalBond);
        }
        json(res, 200, { request: publicDaoHire(current), transactions: { proposal, proposalAndVote: null }, repeated: true }); return;
      }
      // The approval ends when the app asks, within the consent it is relayed under and Sputnik's default proposal period.
      const until = Math.min(Date.parse(validUntil), consent.expiresAt, Date.now() + MAX_HIRE_APPROVAL_MS);
      if (!Number.isFinite(until) || until <= Date.now() + 60_000) { json(res, 409, { code: "expires_too_soon", error: "This approval, or the consent it would be relayed under, ends too soon for a vote. Nothing was filed." }); return; }
      const ends = new Date(until).toISOString();
      const filed = daoFiled(await daoRequests.file({ kind: "hire", deployment: credential.deployment, host: host.toLowerCase(), organization, dao: agent.owner,
        agent: name, agentId: consent.agentId, requestId, approved, brief, validUntil: ends, under: consent.id, expiresAt: until,
        message: hireText({ requestId, agentId: consent.agentId, deployment: credential.deployment, organization, approved, validUntil: ends }),
        signer: { account_id: authority.signer.account_id, public_key: authority.signer.public_key } }, { bond: authority.policy.proposal_bond, stopping,
        assertHeld: () => { assertHeld(); if (!accessLive()) throw new AppAccessEnded(); },
        log: record => ({ deployment: credential.deployment, credential: credential.id, event: "dao-hire-filed", request: record.id,
          consent: consent.id, organization, owner: agent.owner, agent: name, requestId }) }));
      if (!filed) return;
      json(res, 201, { request: publicDaoHire(filed.record), transactions: filed.transactions, repeated: false });
    });
    return true;
  }
  const hireState = pathname.match(/^\/apps\/v1\/dao-hires\/([a-f0-9]{64})$/);
  if (hireState) {
    if (req.method !== "GET") { json(res, 405, { code: "invalid_request", error: "Use GET" }); return true; }
    const record = daoRequests.read(hireState[1]!);
    if (record?.kind !== "hire" || record.deployment !== credential.deployment || record.host !== host.toLowerCase()) { json(res, 404, { code: "not_found", error: "No such DAO hire approval" }); return true; }
    if (record.relayed) { json(res, 200, { state: "relayed", request: publicDaoHire(record), hireState: record.relayed.state }); return true; }
    const signature = await daoSignature(record, () => ({ state: "pending", request: publicDaoHire(record) }));
    if (!signature) return true;
    const found = await daoAgent(record.agent, record.organization, "market");
    if ("error" in found || !found.live.includes(record.under)) {
      json(res, 409, { code: "consent_ended", error: "The DAO signed, but its market consent for this app ended or the agent changed. Nothing was relayed." }); return true;
    }
    if (found.authority.signer.public_key !== record.signer.public_key || found.authority.agentId !== record.agentId) {
      json(res, 409, { code: "agent_changed", error: "The DAO signed, but the agent is no longer that DAO's agent with that identity. Nothing was relayed." }); return true;
    }
    if (stopping()) { json(res, 503, { error: "Gateway is stopping. Nothing was relayed; read again." }); return true; }
    if (!stillAuthorized() || !consents.live({ deployment: credential.deployment, host, organization: record.organization, agent: record.agent }).some(c => c.id === record.under)) {
      json(res, 403, { code: "access_ended", error: "Access ended before relaying. Nothing was relayed." }); return true;
    }
    const approval = marketApproveInput.parse({ requestId: record.requestId, brief: record.brief, approved: record.approved, validUntil: record.validUntil,
      signed: { message: record.message, nonce: record.nonce, publicKey: record.signer.public_key, signature: signature.toString("base64") } });
    let answer: unknown;
    // Relaying again is answered from the agent's journal: a hire is paid at most once per requestId.
    try { answer = await agentCall(found.agent, credential.deployment, host, record.organization, record.under, found.live).market.approve(approval); }
    catch (error) {
      json(res, 409, { code: "agent_refused", error: `The agent refused the DAO's approval: ${error instanceof Error ? error.message : "refused"}. Reading again relays the same signature.` }); return true;
    }
    const parsed = marketHireOutput.safeParse(answer);
    if (!parsed.success || parsed.data.requestId !== record.requestId || parsed.data.state === "not_found") {
      json(res, 502, { code: "agent_answer_unverified", error: "The agent gave no recorded hire outcome. Reading again checks the same approval." }); return true;
    }
    if (parsed.data.state === "funding" || parsed.data.state === "funding_review") {
      // Funding may still be pending or require review. Keep the signed approval available for another read;
      // once it expires, daoSignature requires a new vote over the same hire terms.
      json(res, 200, { state: "pending", request: publicDaoHire(record), hireState: parsed.data.state }); return true;
    }
    const relayed = daoRequests.hireRelayed(record.id, parsed.data.state);
    appendSynced(accessLog(ROOT), { at: new Date().toISOString(), deployment: credential.deployment, credential: credential.id,
      event: "dao-hire-relayed", request: record.id, consent: record.under, organization: record.organization, owner: record.dao, agent: record.agent,
      requestId: record.requestId });
    json(res, 200, { state: "relayed", request: publicDaoHire(relayed), hireState: relayed.relayed!.state }); return true;
  }

  const revoke = pathname.match(/^\/apps\/v1\/consents\/([a-f0-9]{64})$/);
  if (revoke) {
    if (req.method !== "DELETE") { json(res, 405, { code: "invalid_request", error: "Use DELETE" }); return true; }
    if (!consents.revoke(revoke[1]!, { deployment: credential.deployment, host })) { json(res, 404, { code: "not_found", error: "No such consent" }); return true; }
    appendSynced(accessLog(ROOT), { at: new Date().toISOString(), deployment: credential.deployment, credential: credential.id, event: "revoke", consent: revoke[1] });
    json(res, 200, { revoked: true }); return true;
  }

  const releaseRoute = pathname.match(/^\/apps\/v1\/o\/([A-Za-z0-9_-]{1,128})\/a\/([a-z0-9-]{1,32})\/release$/);
  if (releaseRoute) {
    if (req.method !== "POST") { json(res, 405, { code: "invalid_request", error: "Use POST" }); return true; }
    const parsed = releaseInput.safeParse(await readJson(req));
    if (!parsed.success) { json(res, 400, { code: "invalid_request", error: "Send only allowBalance, if needed." }); return true; }
    const registry = options.hosted;
    if (!registry || !options.stopHosted) { json(res, 403, { code: "not_allowed", error: "Hosted release isn't available here." }); return true; }
    const [, organization, name] = releaseRoute as [string, string, string];
    const agent = selected.find(a => a.name === name && reachable(a, credential.deployment, organization));
    const previous = registry.released(name);
    if ((!agent || !(agent as { deployment?: string }).deployment) && (!previous || previous.deployment !== credential.deployment || previous.organization !== organization)) {
      json(res, 403, { code: "no_consent", error: "No hosted reservation for this app and Organization." }); return true;
    }
    await registry.withLifecycle(name, async assertCurrent => {
      // A durable release record proves this hosting-only transition was already authorized. Complete it after a crash
      // even when its consents have been revoked; the service credential still binds the deployment and Organization.
      let record = registry.released(name);
      if (!record) {
        const authority = agent && await resolveWalletAuthority(agent.owner, agent);
        if (!agent || !authority?.agentId) { json(res, 403, { code: "not_owner", error: "Release needs a created wallet-owned agent." }); return; }
        const covering = consents.live({ deployment: credential.deployment, host, organization, agent: name })
          .filter(c => c.signer !== "dao" && c.owner === agent.owner && c.agentId === authority.agentId && c.scopes.includes("owner"));
        const consent = covering[0];
        if (!consent) { json(res, 403, { code: "scope", error: "A live owner consent is required to release this agent." }); return; }
        if (!await consentKeyHolds(consents, consent, keyState)) { json(res, 403, { code: "consent_revoked", error: "The consent's signing key was removed." }); return; }
        if (stopping() || !stillAuthorized() || !consents.live({ deployment: credential.deployment, host, organization, agent: name }).some(c => c.id === consent.id)) {
          json(res, 503, { error: "Access changed while release was checked. Nothing further was applied." }); return;
        }
        const checked = await agentCall(agent, credential.deployment, host, organization, consent.id, covering.map(c => c.id)).releaseCheck({ ...parsed.data, owner: agent.owner, agentId: authority.agentId }, { signal: AbortSignal.timeout(60_000) });
        if (checked.state === "refused") { json(res, 200, appReleaseOutput.parse(checked)); return; }
        assertCurrent();
        // The marker is already durable. If authority ends here, leave it blocked; recovery may finish only after a new consent.
        if (!stillAuthorized() || !consents.live({ deployment: credential.deployment, host, organization, agent: name }).some(c => c.id === consent.id)) {
          json(res, 503, { error: "Access ended after the executor was marked. It remains blocked; restore consent before completing release." }); return;
        }
        record = registry.release(name, checked);
      }
      if (record.deployment !== credential.deployment || record.organization !== organization) {
        json(res, 403, { code: "no_consent", error: "No reservation for this app and Organization." }); return;
      }
      assertCurrent();
      const releasing = record;
      for (const c of consents.list({}).filter(c => c.agent === name && c.owner === releasing.owner))
        consents.revoke(c.id, null, Date.now(), "agent-release");
      await options.stopHosted!(name);
      assertCurrent();
      record = registry.completeRelease(name);
      json(res, 200, appReleaseOutput.parse({ state: "released", agent: name, agentId: record.agentId, at: record.at, archiveCorrelationId: record.archiveCorrelationId }));
    });
    return true;
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
  // `DAO_APP_ACTIONS` (a Treasury or market grant, its revocation, a policy edit, freeze or unfreeze), which the platform
  // prepares and files as its proposal; which consent scope covers each is checked below (`covers`).
  const prepared = path === "owner/prepare" ? (byDao ? appMayPrepareForDao(input) : appMayPrepare(input)) : undefined;
  if (prepared === null) {
    json(res, 403, { code: "not_allowed", access: "procedure", error: byDao ? "Through an app, a DAO (signer \"dao\") votes on scoped grants, revocations, policy edits, freeze, unfreeze and held-payout approvals."
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
  // A DAO's treasury consent also covers preparing the owner actions it votes on (checked above); its market consent, a
  // market agent's own grant, its revocation, freeze, unfreeze and cap edits (`daoMarketMayAsk`, #67).
  const covers = (c: ConsentRecord) => byDao
    ? (mayCall(authority.access, path) && (daoScopesCover(c.scopes, path) || (c.agentId === UNBORN && FOLLOW_CREATION.has(path))) && path !== "owner/prepare")
      || (prepared !== undefined && (c.agentId === UNBORN ? prepared.type === "agent_create" && (prepared.role ?? "treasury") === (agent.area === "payables" ? "payout" : agent.area) : prepared.type !== "agent_create"
        && ((c.scopes.includes("treasury") && prepared.type !== "approval_vote" && !(prepared.type === "grant_issue" && prepared.label === "payout")) || (agent.area === "payables" && c.scopes.includes("payout") && daoPayoutMayAsk(prepared)) || (agent.area === "market" && c.scopes.includes("market") && daoMarketMayAsk(prepared)))))
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
  // A Treasury proposal or limit order uses the same signed { id, signed } envelope. The gateway checks the owner's
  // full-access key and this host before the agent compares the text with its immutable terms.
  if (path === "proposals/approve" || path === "proposals/reject" || path === "limitOrders/approve" || path === "limitOrders/reject") {
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
    // A vote on a held payout is readable but names no payee or amount, so it gets a confirm link too (below).
    const vote = !byDao && standard === "nep413" && prepared.type === "approval_vote" ? prepared : null;
    if (standard === "nep413" && !byDao && !vote) return null;
    const log = (event: string) => appendSynced(accessLog(ROOT), { at: new Date().toISOString(), deployment: credential.deployment,
      credential: credential.id, event, consent: consent.id, organization, owner: agent.owner, agent: name, action: prepared.type,
      correlationId: (raw.json as { correlationId?: unknown } | undefined)?.correlationId ?? null });
    /** The confirm link for an owner action, and the answer that carries it: a NEP-366 intent and its signer are held back. */
    const link = (data: z.infer<typeof ownerPrepareOutput>) => {
      const { intent, signer, ...answer } = data;
      const held = intent?.standard === "nep366";
      const { token } = confirms.hold({ deployment: credential.deployment, host: host.toLowerCase(), organization, owner: agent.owner, agent: name,
        agentId: authority.agentId, consent: consent.id, correlationId: answer.correlationId, type: prepared.type, action: prepared,
        policy: answer.policy ?? null, summary: answer.preview.summary ?? null, expiresAt: answer.expiresAt,
        intent: intent as never, signer: signer as never, ...(answer.payment && { payment: answer.payment }) });
      log("confirm");
      // The serializer's notes about a withheld intent go with it.
      const meta = !Array.isArray(raw.meta) ? [] : held ? raw.meta.filter(entry => !(Array.isArray(entry) && entry[1] === "intent")) : raw.meta;
      const confirm = { url: `https://${host.toLowerCase()}/confirm/${token}`, expiresAt: answer.expiresAt };
      return { answer: { json: { ...(held ? answer : data), confirm }, meta } };
    };
    if (vote && output.success) {
      // The terms the page shows are the agent's, proven against the provider's evidence, and must name the payout and
      // verdict the app asked for; without them there is no page to show, and the app gets the vote as before.
      const { payment, signer } = output.data;
      const proven = payment && payment.correlationId === vote.correlationId && payment.verdict === vote.verdict &&
        (payment.terms === null) === (vote.verdict === "reject") && signer?.type === "near";
      return proven ? link(output.data) : null;
    }
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
    return link(output.data);
  });
  // Proposals and limit orders are bound to their own consent and the signing host. A renewed consent may follow one
  // only if it carries the same scopes, so a plain Treasury consent cannot inherit an order's approval or placement.
  const context = path.startsWith("proposals/") || path.startsWith("limitOrders/") ? { consent: consent.id, host: host.toLowerCase(),
    consents: live.filter(c => matches(c) && c.scopes.includes("treasury") &&
      (!path.startsWith("limitOrders/") || c.scopes.includes("treasury-orders"))).map(c => c.id) } : undefined;
  forwardRpc(req, res, agent, path, undefined, body, `app:${credential.deployment}:${organization}`, release || undefined, context);
  return true;
}
