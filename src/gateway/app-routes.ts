import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { daoPolicy } from "../chain.js";
import { readJson, sendJson as json } from "../http.js";
import { chainKeyState, hourlyLimit, type KeyLookup, type KeyStateLookup } from "../signin.js";
import { appendSynced } from "../synced.js";
import type { AgentEntry } from "./config.js";
import { consentKeyHolds, AppConsents, AppCredentials, appMayCall, appMayPrepare, appMayRelease, setupConsent, UNBORN, verifyConsent, verifySetup, type ConsentRecord } from "./app-access.js";
import { AuthorityUnanswered, resolveWalletAuthority } from "./machine-authority.js";
import { forwardRpc } from "./rpc-proxy.js";

const ROOT = ".app-access";
const credentials = new AppCredentials(ROOT), consents = new AppConsents(ROOT);
const mayUse = hourlyLimit(1_200);
const publicConsent = ({ message: _m, nonce: _n, signature: _s, ...record }: ConsentRecord) => record;

const FOLLOW_CREATION = new Set(["owner/status", "owner/actions", "owner/pending"]);

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
export async function appRoutes(req: IncomingMessage, res: ServerResponse, pathname: string, host: string,
  selected: AgentEntry[], stopping: () => boolean, options: { keyState?: KeyStateLookup; setup?: HostedSetup } = {}): Promise<boolean> {
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
  selected: AgentEntry[], stopping: () => boolean, options: { keyState?: KeyStateLookup; setup?: HostedSetup }): Promise<boolean> {
  const keyState = options.keyState ?? chainKeyState;
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
    const authority = agent && await resolveWalletAuthority(agent.owner, agent);
    if (!agent || !authority) { json(res, 404, { error: "No wallet-owned agent of that name here, or its owner couldn't be confirmed" }); return true; }
    json(res, 200, { agent: agent.name, owner: agent.owner, agentId: authority.agentId, created: authority.agentId !== null,
      host: host.toLowerCase(), deployment: credential.deployment }); return true;
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
    if (!authority) { json(res, 409, { error: "Current wallet ownership could not be verified. DAO consent is not available yet." }); return true; }
    if (authority.agentId === null) { json(res, 409, { error: "This agent isn't created yet. Use the setup consent to create it, then ask the owner to sign." }); return true; }
    if (authority.agentId !== verified.agentId) { json(res, 409, { error: "The consent names another agent identity. Read the agent again and ask the owner to sign." }); return true; }
    if (stopping()) { json(res, 503, { error: "Gateway is stopping. Nothing was stored." }); return true; }
    const record = consents.store(verified);
    appendSynced(join(ROOT, "access.jsonl"), { at: new Date().toISOString(), deployment: credential.deployment, credential: credential.id,
      event: "consent", consent: record.id, organization: record.organization, owner: record.owner, agent: record.agent, scopes: record.scopes });
    json(res, 201, { consent: publicConsent(record) }); return true;
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
  if (!agent || !live.length) { json(res, 403, { error: "No live owner consent covers this Organization and agent" }); return true; }
  const input = await readJson(req);
  // Only the owner's own wallet signs through the app (no DAO path until DAO consent exists), and only what it
  // can read or what the platform built entirely.
  const prepared = path === "owner/prepare" ? appMayPrepare(input) : undefined;
  if (prepared === null) {
    json(res, 403, { error: "Through an app, the owner's wallet (signer \"wallet\") signs only: agent creation without payees, freeze, " +
      "unfreeze, grants, and policy edits to destinations and budget. Other owner actions are signed on the platform." }); return true;
  }
  const body = JSON.stringify(input);
  const authority = await resolveWalletAuthority(agent.owner, agent);
  // A setup consent (UNBORN) acts only while the agent isn't created; afterwards it may still follow the creation it
  // relayed (status reads), and nothing else. Any other consent matches only the agent it names.
  const matches = (c: ConsentRecord) => c.agentId === (authority!.agentId ?? UNBORN) ||
    (c.agentId === UNBORN && authority!.agentId !== null && FOLLOW_CREATION.has(path));
  const consent = authority && live.find(c => matches(c) && appMayCall(c.scopes, authority.access, path));
  if (!authority || !consent) { json(res, 403, { error: "Current ownership, agent identity or consent scope could not be verified" }); return true; }
  // Removing a key is how an owner answers its compromise: the chain saying so ends the consent for good. A failed
  // lookup refuses this call only.
  let holds: boolean;
  try { holds = await consentKeyHolds(consents, consent, keyState); }
  catch { json(res, 503, { error: "The consent's signing key couldn't be checked. Nothing was forwarded; reading again is safe." }); return true; }
  if (!holds) { json(res, 403, { error: "The key that signed this consent was removed from its owner's account, so the consent was revoked" }); return true; }
  // The owner key a created agent answers to is the one that signed (and was checked full-access for) this consent.
  if (prepared?.type === "agent_create" && prepared.owner?.public_key !== consent.publicKey) {
    json(res, 403, { error: "Create the agent with the key that signed the setup" }); return true;
  }
  if (stopping() || !credentials.authenticate(req.headers.authorization, host) ||
    !consents.live({ deployment: credential.deployment, host, organization, agent: name }).some(c => c.id === consent.id)) {
    json(res, 403, { error: "Access ended before forwarding" }); return true;
  }
  appendSynced(join(ROOT, "access.jsonl"), { at: new Date().toISOString(), deployment: credential.deployment, credential: credential.id,
    event: "call", consent: consent.id, organization, owner: agent.owner, agent: name, agentId: authority.agentId, path });
  // A policy edit that turns out to need on-chain (NEP-366) signing isn't released: the provider expires its intent unsigned.
  const release = prepared && ((reply: unknown) => {
    if (appMayRelease(prepared.type, reply)) return null;
    appendSynced(join(ROOT, "access.jsonl"), { at: new Date().toISOString(), deployment: credential.deployment, credential: credential.id,
      event: "withheld", consent: consent.id, organization, owner: agent.owner, agent: name, action: prepared.type,
      correlationId: (reply as { json?: { correlationId?: unknown } }).json?.correlationId ?? null });
    return "This owner action needs on-chain signing, which the app can't show the owner readably. It wasn't released and expires unsigned; sign it on the platform.";
  });
  forwardRpc(req, res, agent, path, undefined, body, `app:${credential.deployment}:${organization}`, release || undefined);
  return true;
}
