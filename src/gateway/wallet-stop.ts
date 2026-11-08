import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { z } from "zod";
import { appConsentSubmission } from "../contract/app-consent.js";
import { readJson, sendJson as json, serveStatic } from "../http.js";
import { nep413Hash, signatureBytes, verifyEd25519 } from "../nep413.js";
import type { Router } from "../router.js";
import { chainKeyState, clientAddress, hourlyLimit, type KeyStateLookup } from "../signin.js";
import { appendSynced, writeAtomic } from "../synced.js";
import { agentOrigin } from "./agent-origin.js";
import { accessLog, AppConsents, privateDirectory, readRecord } from "./app-access.js";
import type { AgentEntry } from "./config.js";
import { resolveWalletAuthority } from "./machine-authority.js";
import { EVERY_AGENT, MAX_WALLET_STOP_MS, parseWalletStopMessage } from "./wallet-stop-text.js";

/**
 * A wallet owner's own stop, with no app involved: the counterpart of a DAO's stop (dao-stop.ts) for an agent a wallet
 * owns. The owner signs the stop text (wallet-stop-text.ts) on `/confirm/wallet/stop`, or with any tool that signs
 * NEP-413, and anyone may send the signature to `POST /confirm/v1/wallet-stop`. Applied, it ends every app consent the
 * owner gave for the agents it names before it was first applied, and turns their autopilot off. It only removes
 * authority: it doesn't freeze an agent or revoke its grant, so an app the owner consents to afterwards may turn
 * autopilot on again under that grant.
 *
 * Additive state under `.app-access/wallet-stops/`: one record per signed stop, named by its signature's hash. The
 * record fixes the stop's cutoff and agents when first applied; sending the same stop again only finishes what is left
 * (an autopilot not yet confirmed off) and never ends a consent given after the cutoff.
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
  write(record: WalletStopRecord) {
    privateDirectory(this.dir);
    writeAtomic(join(this.dir, `${record.id}.json`), JSON.stringify(WalletStopRecord.parse(record)) + "\n", 0o600);
    return record;
  }
}

/** Who owns an agent now, as its server and the chain report it: its provider ID if this wallet does, else null. Throws if unanswered. */
export type WalletOwnerRead = (account: string, agent: AgentEntry) => Promise<{ agentId: string | null } | null>;
const walletOwner: WalletOwnerRead = async (account, agent) => {
  const authority = await resolveWalletAuthority(account, agent);
  return authority && { agentId: authority.agentId };
};

/** Stops sent an hour from one address: an owner sends one or a few; each reads the chain and the agents. */
const mayStop = hourlyLimit(60);
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
  if (pathname !== "/confirm/v1/wallet-stop") return false;
  if (req.method !== "POST") { json(res, 405, { error: "Use POST" }); return true; }
  if (!(options.mayUse ?? mayStop)(clientAddress(req))) { json(res, 429, { error: "Too many stops from this address. Nothing changed; send it again within the hour." }); return true; }
  const reads = { keyState: options.keyState ?? chainKeyState, walletOwner: options.walletOwner ?? walletOwner, stopAutopilot: options.stopAutopilot ?? agentAutopilotOff };
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

type Reads = { keyState: KeyStateLookup; walletOwner: WalletOwnerRead; stopAutopilot: (agent: AgentEntry, owner: string) => Promise<void> };

async function stop(signed: ReturnType<typeof verified>, root: string, selected: AgentEntry[], stopping: () => boolean, reads: Reads) {
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
    consentsEnded: record.ended.filter(e => e.agent === t.agent).length, autopilot: autopilot[t.agent]! })) };
}

/** The agent's own `autopilot/stop`, called by the gateway for its wallet owner. */
async function agentAutopilotOff(agent: AgentEntry, owner: string) {
  const client: RouterClient<Router> = createORPCClient(new RPCLink({ origin: agentOrigin(agent), url: "/rpc", headers: { "x-gateway-actor": owner } }));
  await client.autopilot.stop(undefined, { signal: AbortSignal.timeout(5_000) });
}
