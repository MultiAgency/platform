import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { z } from "zod";
import { appConsentSubmission } from "../contract/app-consent.js";
import { ownerPrepareOutput } from "../contract/owner-outputs.js";
import { readJson, sendJson as json, serveStatic } from "../http.js";
import { nep413Hash, signatureBytes, verifyEd25519 } from "../nep413.js";
import { ownerSignatureProblem } from "../owner-signature.js";
import type { Router } from "../router.js";
import { chainKeyState, clientAddress, hourlyLimit, type KeyStateLookup } from "../signin.js";
import { appendSynced, writeAtomic } from "../synced.js";
import { agentOrigin } from "./agent-origin.js";
import { accessLog, AppConsents, jsonFiles, privateDirectory, readRecord } from "./app-access.js";
import type { AgentEntry } from "./config.js";
import { resolveWalletAuthority } from "./machine-authority.js";
import { EVERY_AGENT, MAX_WALLET_STOP_MS, parseWalletStopMessage } from "./wallet-stop-text.js";

/**
 * A wallet owner's own stop, with no app involved: the counterpart of a DAO's stop (dao-stop.ts) for an agent a wallet
 * owns. The owner signs the stop text (wallet-stop-text.ts) on `/confirm/wallet/stop`, or with any tool that signs
 * NEP-413, and anyone may send the signature to `POST /confirm/v1/wallet-stop`. Applied, it ends every app consent the
 * owner gave for the agents it names before it was first applied, and turns their autopilot off. That only removes
 * authority: it doesn't revoke a grant, so an app the owner consents to afterwards may turn autopilot on again under it.
 *
 * A stop whose signed text says `"freeze":true` also prepares each created agent's freeze: the gateway asks that agent's
 * own `owner/prepare` for `agent_freeze` (signer: the owner's wallet; effectless) and hands back the provider's intent
 * unchanged, once it is one the owner's wallet signs for that agent (`freezeProblem`). The owner's wallet signs it on the
 * stop page; `POST /confirm/v1/wallet-stop/freeze` checks that signature against the held intent and forwards it to the
 * agent's own `owner/submit`, where the provider verifies it; `/freeze-status` follows it with `owner/status`. The
 * signed stop is the only proof of ownership either asks for, so a freeze is only ever prepared for the stop's owner and
 * agents, and only the owner's signature over the provider's own intent is submitted. A freeze stops every send, in the
 * provider; the agent stays frozen until its owner unfreezes it, which isn't offered here.
 *
 * Additive state under `.app-access/wallet-stops/`: one record per signed stop, named by its signature's hash. The
 * record fixes the stop's cutoff and agents when first applied; sending the same stop again only finishes what is left
 * (an autopilot not yet confirmed off, a freeze not yet signed) and never ends a consent given after the cutoff. Each
 * stop's prepared freezes are under `.app-access/wallet-freezes/`, named the same, so a gateway before freezing reads its
 * stop records unchanged.
 */
type Target = { agent: string; agentId: string | null };
/** What a retry found of an agent: its autopilot turned off, or nothing of it left for this owner to stop. */
const Settled = z.enum(["off", "replaced", "owner changed"]);
const WalletStopRecord = z.strictObject({ version: z.literal(1), id: z.string().regex(/^[a-f0-9]{64}$/), host: z.string(), owner: z.string(),
  agent: z.string(), message: z.string(), nonce: z.string(), publicKey: z.string(), signature: z.string(), expiresAt: z.number().int(),
  /** When the stop was first applied: the consents it ends are the ones given by then. */
  at: z.number().int(),
  targets: z.array(z.strictObject({ agent: z.string(), agentId: z.string().nullable() })),
  /** The consents it ended, recorded before each is revoked. */
  ended: z.array(z.strictObject({ id: z.string(), agent: z.string() })),
  settled: z.record(z.string(), Settled) });
type WalletStopRecord = z.infer<typeof WalletStopRecord>;

class WalletStops {
  private readonly dir: string;
  constructor(root: string) { this.dir = join(root, "wallet-stops"); }
  read(id: string) { return readRecord(join(this.dir, `${id}.json`), WalletStopRecord); }
  /** This owner's stops on this host. Another owner's record is read only as far as its owner and host, so it can't fail this one. */
  ofOwner(host: string, owner: string) {
    return jsonFiles(this.dir).flatMap(file => {
      const raw = JSON.parse(readFileSync(join(this.dir, file), "utf8")) as { host?: unknown; owner?: unknown } | null;
      return raw?.host === host && raw.owner === owner ? [WalletStopRecord.parse(raw)] : [];
    });
  }
  write(record: WalletStopRecord) {
    privateDirectory(this.dir);
    writeAtomic(join(this.dir, `${record.id}.json`), JSON.stringify(WalletStopRecord.parse(record)) + "\n", 0o600);
    return record;
  }
}

/** A freeze prepared for one of a stop's agents: the provider's intent as the agent answered it, and whether it was sent. */
const HeldFreeze = z.strictObject({ agentId: z.string(), correlationId: z.string().min(1), expiresAt: z.string(),
  intent: ownerPrepareOutput.shape.intent.unwrap(), signer: z.looseObject({ type: z.literal("near"), account_id: z.string(), public_key: z.string() }),
  /** When the owner's signature was first forwarded to the agent's `owner/submit`. */
  submittedAt: z.number().int().nullable() });
type HeldFreeze = z.infer<typeof HeldFreeze>;
const WalletFreezeRecord = z.strictObject({ version: z.literal(1), id: z.string().regex(/^[a-f0-9]{64}$/), owner: z.string(),
  agents: z.record(z.string(), HeldFreeze) });

class WalletFreezes {
  private readonly dir: string;
  constructor(root: string) { this.dir = join(root, "wallet-freezes"); }
  read(id: string) { return readRecord(join(this.dir, `${id}.json`), WalletFreezeRecord); }
  held(id: string, agent: string) { return this.read(id)?.agents[agent] ?? null; }
  write(id: string, owner: string, agent: string, freeze: HeldFreeze) {
    privateDirectory(this.dir);
    const record = WalletFreezeRecord.parse({ version: 1, id, owner, agents: { ...this.read(id)?.agents, [agent]: freeze } });
    writeAtomic(join(this.dir, `${id}.json`), JSON.stringify(record) + "\n", 0o600);
  }
}

/**
 * Why an agent's prepared reply isn't a freeze the stop page may hand the owner's wallet, or null: it must carry an intent
 * the owner's NEAR account signs, still within its window, and a NEP-366 one may call only `freeze_wallet` (the provider's
 * `unfreeze_wallet`, like it, checks only who signs, so one in its place would unfreeze). The agent asked the
 * provider for `agent_freeze` on its own agent ID and refuses a generated intent of another type; a NEP-413 one is text
 * the wallet shows.
 */
function freezeProblem(reply: unknown, owner: string, now = Date.now()): string | null {
  const parsed = ownerPrepareOutput.safeParse(reply);
  if (!parsed.success || !parsed.data.intent || !parsed.data.signer) return "the reply carries no intent for a wallet";
  const { intent, signer, expiresAt } = parsed.data;
  if (signer.type !== "near" || signer.account_id !== owner) return "its signer isn't the owner's NEAR account";
  if (!(Date.parse(expiresAt) > now)) return "its signing window has closed";
  if (intent.standard === "nep366") {
    if (!intent.payload.actions.length || intent.payload.actions.some(a => a.type !== "FunctionCall" || a.params.methodName !== "freeze_wallet"))
      return "it calls something other than freeze_wallet";
    return null;
  }
  return intent.standard === "nep413" ? null : `the owner's wallet doesn't sign ${intent.standard}`;
}

/** What the stop's answer says of an agent's freeze. */
type FreezeView = { state: "sign"; correlationId: string; expiresAt: string; intent: HeldFreeze["intent"]; signer: HeldFreeze["signer"] }
  | { state: "submitted"; correlationId: string } | { state: "not prepared"; reason: string } | { state: "expired"; reason: string };
const signable = (held: HeldFreeze): FreezeView => ({ state: "sign", correlationId: held.correlationId, expiresAt: held.expiresAt, intent: held.intent, signer: held.signer });

/** The agent's own owner procedures, called by the gateway for its wallet owner. Only `agent_freeze` is ever prepared. */
type FreezeCalls = {
  prepareFreeze: (agent: AgentEntry, owner: string) => Promise<unknown>;
  submit: (agent: AgentEntry, owner: string, correlationId: string, signedData: Record<string, unknown>) => Promise<unknown>;
  status: (agent: AgentEntry, owner: string, correlationId: string) => Promise<unknown>;
};
const agentClient = (agent: AgentEntry, owner: string): RouterClient<Router> =>
  createORPCClient(new RPCLink({ origin: agentOrigin(agent), url: "/rpc", headers: { "x-gateway-actor": owner } }));
const agentFreezeCalls: FreezeCalls = {
  prepareFreeze: (agent, owner) => agentClient(agent, owner).owner.prepare({ action: { type: "agent_freeze" }, signer: "wallet" }, { signal: AbortSignal.timeout(30_000) }),
  submit: (agent, owner, correlationId, signedData) => agentClient(agent, owner).owner.submit({ correlationId, signedData }, { signal: AbortSignal.timeout(60_000) }),
  status: (agent, owner, correlationId) => agentClient(agent, owner).owner.status({ correlationId }, { signal: AbortSignal.timeout(15_000) }),
};
/** An agent's public refusal (oRPC's message, which the agent makes public only by construction), else a generic one. */
const reasonOf = (error: unknown) => {
  const message = (error as { message?: unknown } | null)?.message;
  return (error as { name?: unknown } | null)?.name === "ORPCError" && typeof message === "string" ? message : "it didn't answer";
};

/**
 * The latest cutoff of the owner's wallet stops on this host covering `agent`: one naming it when first applied, or one
 * for every agent (only those when `agent` isn't known yet). After it, a consent or setup for that agent is stored only
 * if the platform issued its nonce later (`consent-nonce.ts`): any other nonce can't show the text wasn't signed before
 * the stop. Null if none covers it.
 */
export function walletStopCutoff(root: string, { host, owner, agent }: { host: string; owner: string; agent?: string }) {
  const cutoffs = new WalletStops(root).ofOwner(host.toLowerCase(), owner)
    .filter(stop => stop.agent === EVERY_AGENT || (agent !== undefined && stop.targets.some(target => target.agent === agent))).map(stop => stop.at);
  return cutoffs.length ? Math.max(...cutoffs) : null;
}

/** Who owns an agent now, as its server and the chain report it: its provider ID if this wallet does, else null. Throws if unanswered. */
export type WalletOwnerRead = (account: string, agent: AgentEntry) => Promise<{ agentId: string | null } | null>;
export const walletOwner: WalletOwnerRead = async (account, agent) => {
  const authority = await resolveWalletAuthority(account, agent);
  return authority && { agentId: authority.agentId };
};

/** Stops sent an hour from one address: an owner sends one or a few; each reads the chain and the agents. */
const mayStop = hourlyLimit(60);
/** Freeze submissions and status reads an hour from one address: a page follows a few freezes. */
const mayFollow = hourlyLimit(600);
/** One stop at a time per owner, so a record is written, applied and counted once. */
const locks = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).then(work, work);
  const tail = run.then(() => undefined, () => undefined);
  locks.set(key, tail);
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}
class Refused extends Error { constructor(readonly status: number, message: string) { super(message); } }

export async function walletStopRoutes(req: IncomingMessage, res: ServerResponse, pathname: string, host: string, root: string,
  selected: AgentEntry[], dist: string, stopping: () => boolean, options: { keyState?: KeyStateLookup; walletOwner?: WalletOwnerRead;
    stopAutopilot?: (agent: AgentEntry, owner: string) => Promise<void>; mayUse?: (key: string) => boolean } = {}): Promise<boolean> {
  if (/^\/confirm\/wallet\/stop(\/[a-z0-9-]{1,32})?$/.test(pathname)) {
    if (!["GET", "HEAD"].includes(req.method ?? "")) { json(res, 405, { error: "Use GET" }); return true; }
    await serveStatic(res, dist, "/confirm.html"); return true;
  }
  const route = pathname.match(/^\/confirm\/v1\/wallet-stop(\/freeze|\/freeze-status)?$/);
  if (!route) return false;
  if (req.method !== "POST") { json(res, 405, { error: "Use POST" }); return true; }
  const reads = { keyState: options.keyState ?? chainKeyState, walletOwner: options.walletOwner ?? walletOwner, stopAutopilot: options.stopAutopilot ?? agentAutopilotOff,
    freeze: agentFreezeCalls };
  if (route[1]) {
    if (!mayFollow(clientAddress(req))) { json(res, 429, { error: "Too many requests from this address. Nothing was sent; try again within the hour." }); return true; }
    try {
      const body = followed.safeParse(await readJson(req));
      if (!body.success) throw new Refused(400, "Send the signed stop, the agent and, to submit, the wallet's signed data.");
      const signed = verified(body.data.stop, host);
      const answer = await serialized<object>(`${signed.host}/${signed.owner}`, () =>
        route[1] === "/freeze" ? submitFreeze(signed, body.data.agent, body.data.signedData, root, selected, stopping, reads) : freezeStatus(signed, body.data.agent, root, selected, reads));
      json(res, 200, answer);
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      json(res, error.status, { error: error.message });
    }
    return true;
  }
  if (!(options.mayUse ?? mayStop)(clientAddress(req))) { json(res, 429, { error: "Too many stops from this address. Nothing changed; send it again within the hour." }); return true; }
  try {
    const signed = verified(await readJson(req), host);
    const answer = await serialized(`${signed.host}/${signed.owner}`, () => stop(signed, root, selected, stopping, reads));
    json(res, 200, answer);
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    json(res, error.status, { error: error.message });
  }
  return true;
}

/** The signed stop, if its text is canonical, names this host and carries a NEP-413 signature over it by the key it names. */
function verified(body: unknown, host: string) {
  const submission = appConsentSubmission.safeParse(body);
  if (!submission.success) throw new Refused(400, "Send the signed stop: message, nonce, publicKey and signature.");
  const { message, nonce, publicKey, signature } = submission.data;
  const text = parseWalletStopMessage(message);
  if (!text) throw new Refused(400, "The stop text isn't a canonical wallet stop.");
  if (text.host !== host.toLowerCase()) throw new Refused(400, "The stop names another platform host.");
  const nonceBytes = Buffer.from(nonce, "base64");
  if (nonceBytes.length !== 32) throw new Refused(400, "The NEP-413 nonce must be 32 bytes.");
  let bytes: Buffer, valid = false;
  try { bytes = signatureBytes(signature); valid = verifyEd25519(publicKey, nep413Hash(message, nonceBytes, text.host), bytes); }
  catch { throw new Refused(403, "The signature doesn't match this stop."); }
  if (!valid) throw new Refused(403, "The signature doesn't match this stop.");
  return { ...text, id: createHash("sha256").update(bytes.toString("hex")).digest("hex"), message, nonce, publicKey, signature };
}

type Reads = { keyState: KeyStateLookup; walletOwner: WalletOwnerRead; stopAutopilot: (agent: AgentEntry, owner: string) => Promise<void>; freeze: FreezeCalls };
type Signed = ReturnType<typeof verified>;

/** A call following a stop's freeze: the signed stop again (its signature is the proof), the agent, and to submit, the wallet's signature. */
const followed = z.object({ stop: z.unknown(), agent: z.string(), signedData: z.record(z.string(), z.unknown()).optional() });

async function stop(signed: Signed, root: string, selected: AgentEntry[], stopping: () => boolean, reads: Reads) {
  const { fresh, ...answer } = await applyStop(signed, root, selected, stopping, reads);
  if (!signed.freeze) return answer;
  const record = new WalletStops(root).read(signed.id)!;
  const freezes = await prepareFreezes(signed, record, root, selected, stopping, reads, fresh);
  return { at: answer.at, agents: answer.agents.map(a => ({ ...a, freeze: freezes[a.agent]! })) };
}

async function applyStop(signed: Signed, root: string, selected: AgentEntry[], stopping: () => boolean, reads: Reads) {
  const stops = new WalletStops(root);
  const existing = stops.read(signed.id);
  if (existing) return apply(root, stops, existing, selected, stopping, reads);
  const now = Date.now(), expiresAt = Date.parse(signed.expiresAt);
  if (expiresAt <= now) throw new Refused(400, "This stop has expired. Sign a new one.");
  if (expiresAt > now + MAX_WALLET_STOP_MS) throw new Refused(400, "A stop lasts at most an hour after it is signed.");
  let key: Awaited<ReturnType<KeyStateLookup>>;
  try { key = await reads.keyState(signed.owner, signed.publicKey); }
  catch { throw new Refused(503, "The owner's key couldn't be checked now. Nothing changed; send it again."); }
  if (key !== "FullAccess") throw new Refused(403, `${signed.publicKey} is not a full-access key of ${signed.owner}.`);
  const named = selected.filter(a => a.owner === signed.owner && (signed.agent === EVERY_AGENT || a.name === signed.agent));
  const targets: (Target & { entry: AgentEntry })[] = [];
  for (const entry of named) {
    let owned: Awaited<ReturnType<WalletOwnerRead>>;
    try { owned = await reads.walletOwner(signed.owner, entry); }
    catch { throw new Refused(503, "The agents' ownership couldn't be checked now. Nothing changed; send it again."); }
    if (owned) targets.push({ agent: entry.name, agentId: owned.agentId, entry });
  }
  if (!targets.length) throw new Refused(404, `No agent of ${signed.owner}${signed.agent === EVERY_AGENT ? "" : ` named ${signed.agent}`} on this host. Nothing changed.`);
  if (stopping()) throw new Refused(503, "The platform is restarting. Nothing changed; send it again.");
  const record = stops.write({ version: 1, id: signed.id, host: signed.host, owner: signed.owner, agent: signed.agent, message: signed.message,
    nonce: signed.nonce, publicKey: signed.publicKey, signature: signed.signature, expiresAt, at: now,
    targets: targets.map(({ agent, agentId }) => ({ agent, agentId })), ended: [], settled: {} });
  appendSynced(accessLog(root), { at: new Date(now).toISOString(), event: "wallet-stop-filed", request: record.id, owner: record.owner, agent: record.agent });
  return apply(root, stops, record, selected, stopping, reads, new Map(targets.map(t => [t.agent, t])));
}

/**
 * Ends every consent the owner gave for the stop's agents by its cutoff (recorded before each is revoked, so a crash
 * between leaves them on record and the next send revokes them), then turns each created agent's autopilot off. An agent
 * found replaced or owned by someone else on a retry is no longer this owner's to stop. `fresh`: the ownership just read
 * when the stop was first applied.
 */
async function apply(root: string, stops: WalletStops, record: WalletStopRecord, selected: AgentEntry[], stopping: () => boolean, reads: Reads,
  fresh?: Map<string, Target>) {
  if (stopping()) throw new Refused(503, "The platform is restarting. Nothing more was applied; send it again.");
  const consents = new AppConsents(root), now = Date.now(), names = new Set(record.targets.map(t => t.agent));
  const ending = consents.list({}).filter(c => c.host === record.host && c.owner === record.owner && names.has(c.agent) && !c.revoked && c.createdAt <= record.at)
    .map(c => ({ id: c.id, agent: c.agent }));
  const ended = [...record.ended, ...ending.filter(e => !record.ended.some(r => r.id === e.id))];
  record = stops.write({ ...record, ended });
  for (const { id } of ending) consents.revoke(id, null, now, "wallet-stop");
  const settled = { ...record.settled };
  const autopilot: Record<string, string> = {};
  for (const target of record.targets) {
    if (target.agentId === null) { autopilot[target.agent] = "not created"; continue; }
    if (settled[target.agent]) { autopilot[target.agent] = settled[target.agent]!; continue; }
    const entry = selected.find(a => a.name === target.agent);
    let current: Target | null = fresh?.get(target.agent) ?? null;
    if (!fresh && entry) try { const owned = await reads.walletOwner(record.owner, entry); current = owned && { agent: target.agent, agentId: owned.agentId }; }
    catch { autopilot[target.agent] = "not confirmed off"; continue; }
    if (!entry || !current) settled[target.agent] = "owner changed";
    else if (current.agentId !== target.agentId) settled[target.agent] = "replaced";
    else try { await reads.stopAutopilot(entry, record.owner); settled[target.agent] = "off"; } catch { /* not confirmed: the next send asks again */ }
    autopilot[target.agent] = settled[target.agent] ?? "not confirmed off";
  }
  record = stops.write({ ...record, settled });
  appendSynced(accessLog(root), { at: new Date(now).toISOString(), event: "wallet-stop", request: record.id, owner: record.owner,
    agent: record.agent, revoked: ending.map(e => e.id), autopilot });
  return { at: new Date(record.at).toISOString(), agents: record.targets.map(t => ({ agent: t.agent, agentId: t.agentId,
    consentsEnded: record.ended.filter(e => e.agent === t.agent).length, autopilot: autopilot[t.agent]! })), fresh };
}

/**
 * Each of the stop's created agents' freeze: the one already prepared while it can still be signed (or once it was
 * submitted), else a new one from the agent's own `owner/prepare`, only while the signed stop is unexpired, and only for
 * the agent the stop named (its server reports the same provider ID and this owner now). A failure leaves the stop applied
 * and says why; sending the same stop again tries again.
 */
async function prepareFreezes(signed: Signed, record: WalletStopRecord, root: string, selected: AgentEntry[], stopping: () => boolean, reads: Reads,
  fresh?: Map<string, Target>) {
  const freezes = new WalletFreezes(root), views: Record<string, FreezeView> = {};
  for (const target of record.targets) {
    const view = (v: FreezeView) => { views[target.agent] = v; };
    if (target.agentId === null) { view({ state: "not prepared", reason: "not created" }); continue; }
    const held = freezes.held(record.id, target.agent), now = Date.now();
    if (held?.submittedAt != null) { view({ state: "submitted", correlationId: held.correlationId }); continue; }
    if (held && Date.parse(held.expiresAt) > now) { view(signable(held)); continue; }
    if (Date.parse(signed.expiresAt) <= now) { view({ state: "expired", reason: "The freeze and this stop expired unsigned. Sign a new stop to freeze." }); continue; }
    const entry = selected.find(a => a.name === target.agent);
    let current: Target | null = fresh?.get(target.agent) ?? null;
    if (!fresh && entry) try { const owned = await reads.walletOwner(record.owner, entry); current = owned && { agent: target.agent, agentId: owned.agentId }; }
    catch { view({ state: "not prepared", reason: "The agent's ownership couldn't be checked now. Send the same stop again." }); continue; }
    if (!entry || !current) { view({ state: "not prepared", reason: "owner changed" }); continue; }
    if (current.agentId !== target.agentId) { view({ state: "not prepared", reason: "replaced" }); continue; }
    if (stopping()) { view({ state: "not prepared", reason: "The platform is restarting. Send the same stop again." }); continue; }
    let reply: unknown;
    try { reply = await reads.freeze.prepareFreeze(entry, record.owner); }
    catch (error) { view({ state: "not prepared", reason: `The agent couldn't prepare the freeze: ${reasonOf(error)}. Send the same stop again.` }); continue; }
    const problem = freezeProblem(reply, record.owner);
    const log = (event: string, correlationId: unknown) => appendSynced(accessLog(root), { at: new Date().toISOString(), event, request: record.id,
      owner: record.owner, agent: target.agent, agentId: target.agentId, correlationId: typeof correlationId === "string" ? correlationId : null });
    if (problem) {
      log("wallet-freeze-withheld", (reply as { correlationId?: unknown } | null)?.correlationId);
      view({ state: "not prepared", reason: `The agent's freeze wasn't released: ${problem}. It expires unsigned.` }); continue;
    }
    const { correlationId, expiresAt, intent, signer } = ownerPrepareOutput.parse(reply);
    const freeze = HeldFreeze.parse({ agentId: target.agentId, correlationId, expiresAt, intent, signer, submittedAt: null });
    freezes.write(record.id, record.owner, target.agent, freeze);
    log("wallet-freeze-prepared", correlationId);
    view(signable(freeze));
  }
  return views;
}

/** The freeze a stop prepared for `agent`, and the agent's entry, once the stop was applied. */
function heldFreeze(signed: Signed, agent: string, root: string, selected: AgentEntry[]) {
  const record = new WalletStops(root).read(signed.id);
  if (!record) throw new Refused(404, "This stop hasn't been applied. Send the stop first.");
  const held = new WalletFreezes(root).held(record.id, agent);
  if (!held) throw new Refused(404, `No freeze was prepared for ${agent} under this stop.`);
  const entry = selected.find(a => a.name === agent);
  if (!entry) throw new Refused(503, "The agent isn't available now. Nothing was sent.");
  return { record, held, entry };
}

/**
 * The owner's wallet signature over a freeze this stop prepared, checked against the held intent and the provider's owner
 * key here first (so a wrong wallet or other bytes reach nothing), then sent to the agent's own `owner/submit`, which
 * checks it again and submits it to the provider. Sent again, the agent answers from its record.
 */
async function submitFreeze(signed: Signed, agent: string, signedData: Record<string, unknown> | undefined, root: string, selected: AgentEntry[],
  stopping: () => boolean, reads: Reads) {
  if (!signedData) throw new Refused(400, "Send the wallet's signed data.");
  const { record, held, entry } = heldFreeze(signed, agent, root, selected);
  if (held.submittedAt === null && Date.parse(held.expiresAt) <= Date.now()) throw new Refused(410, "This freeze expired unsigned. Send the same stop again to prepare a new one while it is valid, or sign a new stop.");
  const problem = ownerSignatureProblem(held.intent as never, held.signer, signedData);
  if (problem) throw new Refused(400, `Not submitted: ${problem}.`);
  if (stopping()) throw new Refused(503, "The platform is restarting. Nothing was sent; submit again.");
  if (held.submittedAt === null) new WalletFreezes(root).write(record.id, record.owner, agent, { ...held, submittedAt: Date.now() });
  appendSynced(accessLog(root), { at: new Date().toISOString(), event: "wallet-freeze-submitted", request: record.id, owner: record.owner, agent,
    agentId: held.agentId, correlationId: held.correlationId });
  let submitted: unknown;
  try { submitted = await reads.freeze.submit(entry, record.owner, held.correlationId, signedData); }
  catch (error) { throw new Refused(502, `The agent didn't confirm the freeze: ${reasonOf(error)}. It may have been sent; follow its status before signing again.`); }
  return { correlationId: held.correlationId, submitted };
}

/** The agent's own `owner/status` of the freeze this stop prepared. */
async function freezeStatus(signed: Signed, agent: string, root: string, selected: AgentEntry[], reads: Reads) {
  const { record, held, entry } = heldFreeze(signed, agent, root, selected);
  try { return { correlationId: held.correlationId, status: await reads.freeze.status(entry, record.owner, held.correlationId) }; }
  catch (error) { throw new Refused(502, `The agent didn't answer the freeze's status: ${reasonOf(error)}. Ask again.`); }
}

/** The agent's own `autopilot/stop`, called by the gateway for its wallet owner. */
async function agentAutopilotOff(agent: AgentEntry, owner: string) {
  const client: RouterClient<Router> = createORPCClient(new RPCLink({ origin: agentOrigin(agent), url: "/rpc", headers: { "x-gateway-actor": owner } }));
  await client.autopilot.stop(undefined, { signal: AbortSignal.timeout(5_000) });
}
