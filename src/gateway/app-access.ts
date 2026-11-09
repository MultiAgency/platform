import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RPCSerializer } from "@orpc/client";
import { z } from "zod";
import { ownerPrepareInput } from "../contract/inputs.js";
import { proposalSigned } from "../contract/treasury-proposals.js";
import { BadRequest } from "../http.js";
import { nep413Hash, signatureBytes, verifyEd25519 } from "../nep413.js";
import type { KeyLookup, KeyStateLookup } from "../signin.js";
import { moveOnce, writeAtomic } from "../synced.js";
import { AppScope, appConsentSubmission, parseConsentMessage, parseSetupMessage, UNBORN_AGENT } from "../contract/app-consent.js";
import { appMayAsk, appMayAskDao, appScopesCover, AppSigner } from "../contract/app-access.js";
import { mayCall } from "./allowlist.js";
import type { Access } from "./roles.js";

/**
 * App access: a service credential per app deployment (operator-issued) and per-agent owner consents
 * (owner-signed). A call needs both. Additive state under one gateway process; reloaded on every request so revocation
 * survives restart.
 */
const hash = (value: string) => createHash("sha256").update(value).digest();
const deployment = z.string().regex(/^[a-z0-9-]{1,32}$/);
const DAY = 86_400_000;
export const MAX_CREDENTIAL_DAYS = 365, MAX_CONSENT_DAYS = 366;
/**
 * Requests an hour per app credential: the default, and the most the operator may set. The gateway's limiter keeps
 * one timestamp per request in the hour, so the ceiling also bounds its memory per credential.
 */
export const DEFAULT_REQUESTS_PER_HOUR = 1_200, MAX_REQUESTS_PER_HOUR = 12_000;

export function appMayCall(scopes: readonly AppScope[], access: Access, path: string) {
  return mayCall(access, path) && appScopesCover(scopes, path);
}

/** The owner action an `owner/prepare` body asks for, read as the agent server reads it, if the app may ask for it. */
const rpcInput = new RPCSerializer();
/** The correlation ID an `owner/submit` body names, read as the agent server reads it; null when unreadable. */
export function submittedCorrelation(input: unknown) {
  try {
    const decoded = rpcInput.deserialize(input as Parameters<RPCSerializer["deserialize"]>[0]) as { correlationId?: unknown } | null;
    return typeof decoded?.correlationId === "string" ? decoded.correlationId : null;
  } catch { return null; }
}
/**
 * Why the owner's signature an app relays to `proposals/approve` or `proposals/reject` is refused, or null: it must be a
 * NEP-413 signature for this host, by a full-access key of the agent's owner now. The agent then checks the text is
 * exactly the proposal's. A lookup that throws went unanswered and propagates (503).
 */
export async function proposalSignatureProblem(input: unknown, host: string, owner: string, lookup: KeyLookup) {
  let decoded: unknown;
  try { decoded = rpcInput.deserialize(input as Parameters<RPCSerializer["deserialize"]>[0]); } catch { return "The request body is unreadable."; }
  const parsed = proposalSigned.safeParse(decoded);
  if (!parsed.success) return "Send the proposal id and the owner's signed text: message, nonce, publicKey and signature.";
  const { message, nonce, publicKey, signature } = parsed.data.signed;
  const nonceBytes = Buffer.from(nonce, "base64");
  if (nonceBytes.length !== 32) return "The NEP-413 nonce must be 32 bytes.";
  let signed = false;
  try { signed = verifyEd25519(publicKey, nep413Hash(message, nonceBytes, host.toLowerCase()), signatureBytes(signature)); } catch { signed = false; }
  if (!signed) return "The signature doesn't match this text for this host.";
  if (await lookup(owner, publicKey) !== "FullAccess") return `${publicKey} is not a full-access key of ${owner}.`;
  return null;
}
export function appMayPrepare(input: unknown) {
  let decoded: unknown;
  try { decoded = rpcInput.deserialize(input as Parameters<RPCSerializer["deserialize"]>[0]); } catch { return null; }
  const parsed = ownerPrepareInput.safeParse(decoded);
  return parsed.success && parsed.data.signer === "wallet" && appMayAsk(parsed.data.action) ? parsed.data.action : null;
}
/** The owner action an `owner/prepare` body asks a DAO to vote on (`signer: "dao"`), if an app may ask for it. */
export function appMayPrepareForDao(input: unknown) {
  let decoded: unknown;
  try { decoded = rpcInput.deserialize(input as Parameters<RPCSerializer["deserialize"]>[0]); } catch { return null; }
  const parsed = ownerPrepareInput.safeParse(decoded);
  return parsed.success && parsed.data.signer === "dao" && appMayAskDao(parsed.data.action) ? parsed.data.action : null;
}

export function privateDirectory(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const parent = openSync(dirname(root), "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
  if ((statSync(root).mode & 0o077) !== 0) throw new Error("App access directory must be private");
}
export function readRecord<T>(file: string, schema: z.ZodType<T>): T | null {
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  return schema.parse(JSON.parse(text));
}
export const jsonFiles = (dir: string) => {
  try { return readdirSync(dir).filter(file => file.endsWith(".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
};

const Credential = z.strictObject({ version: z.literal(1), id: z.uuid(), secretHash: z.string().regex(/^[a-f0-9]{64}$/),
  deployment, host: z.string().min(1), label: z.string().trim().min(1).max(80), createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(), revoked: z.boolean(),
  /** Set only when the operator chose another limit than the default, so records at the default keep their earlier form. */
  perHour: z.number().int().min(1).max(MAX_REQUESTS_PER_HOUR).optional() });
type Credential = z.infer<typeof Credential>;
const publicCredential = ({ secretHash: _hash, perHour = DEFAULT_REQUESTS_PER_HOUR, ...record }: Credential) => ({ ...record, perHour });
const requestsPerHour = (perHour: number) => {
  if (!Number.isInteger(perHour) || perHour < 1 || perHour > MAX_REQUESTS_PER_HOUR) throw new BadRequest(`Choose 1 to ${MAX_REQUESTS_PER_HOUR} requests an hour.`);
  return perHour === DEFAULT_REQUESTS_PER_HOUR ? {} : { perHour };
};

/** Service credentials: one per app deployment and host, issued and revoked by the platform operator. */
export class AppCredentials {
  private readonly dir: string;
  constructor(root: string) { this.dir = join(root, "credentials"); }
  private read(id: string) {
    if (!z.uuid().safeParse(id).success) return null;
    return readRecord(join(this.dir, `${id}.json`), Credential);
  }
  issue(input: { deployment: string; host: string; label: string; days: number; perHour?: number }, now = Date.now()) {
    if (!Number.isInteger(input.days) || input.days < 1 || input.days > MAX_CREDENTIAL_DAYS) throw new BadRequest(`Choose 1 to ${MAX_CREDENTIAL_DAYS} days.`);
    const limit = requestsPerHour(input.perHour ?? DEFAULT_REQUESTS_PER_HOUR);
    privateDirectory(this.dir);
    const id = randomUUID(), secret = randomBytes(32).toString("base64url");
    const record = Credential.parse({ version: 1, id, secretHash: hash(secret).toString("hex"), deployment: input.deployment,
      host: input.host.toLowerCase(), label: input.label, createdAt: now, expiresAt: now + input.days * DAY, revoked: false, ...limit });
    writeAtomic(join(this.dir, `${id}.json`), JSON.stringify(record) + "\n", 0o600);
    return { credential: publicCredential(record), token: `tap_${id}.${secret}` };
  }
  authenticate(authorization: string | undefined, host: string, now = Date.now()) {
    const match = authorization?.match(/^Bearer tap_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/);
    if (!match) return null;
    const record = this.read(match[1]!);
    if (!record || record.revoked || now >= record.expiresAt || record.host !== host.toLowerCase()) return null;
    return timingSafeEqual(hash(match[2]!), Buffer.from(record.secretHash, "hex")) ? publicCredential(record) : null;
  }
  list() { return jsonFiles(this.dir).map(file => this.read(file.slice(0, -5))).filter(r => r !== null).map(publicCredential); }
  revoke(id: string) {
    const record = this.read(id);
    if (!record) return false;
    writeAtomic(join(this.dir, `${id}.json`), JSON.stringify({ ...record, revoked: true }) + "\n", 0o600);
    return true;
  }
  /** Sets a credential's hourly request limit in place: the token stays, and the gateway reads it on the next call. */
  limit(id: string, perHour: number) {
    const limit = requestsPerHour(perHour), record = this.read(id);
    if (!record) return false;
    const { perHour: _old, ...rest } = record;
    writeAtomic(join(this.dir, `${id}.json`), JSON.stringify(Credential.parse({ ...rest, ...limit })) + "\n", 0o600);
    return true;
  }
}

const Consent = z.strictObject({ version: z.literal(1), id: z.string().regex(/^[a-f0-9]{64}$/), deployment, host: z.string().min(1),
  organization: z.string(), owner: z.string(), agent: z.string(), agentId: z.string().min(1), scopes: z.array(AppScope).min(1),
  expiresAt: z.number().int().positive(), createdAt: z.number().int().nonnegative(), message: z.string(), nonce: z.string(),
  publicKey: z.string(), signature: z.string(), revoked: z.boolean(), revokedAt: z.number().int().nullable(),
  /** Absent on records from before DAO consent: the owner's wallet signed. `dao`: the DAO's derived key, by its vote. */
  signer: AppSigner.optional() });
export type ConsentRecord = z.infer<typeof Consent>;

/** A verified consent, before the platform binds it to the agent's current identity. */
export type VerifiedConsent = Omit<ConsentRecord, "createdAt" | "revoked" | "revokedAt">;

/** What an app text says, as far as the shared checks need it. */
type Signable = { host: string; deployment: string; owner: string; expiresAt: string };

/**
 * The checks every owner-signed app text gets: canonical text, this host, the calling deployment, an expiry between a
 * minute and `maxMs` from now, a 32-byte nonce, a NEP-413 signature for recipient the host (no callback URL), and a
 * full-access key of the owner now. Throws a BadRequest saying why it's refused; nothing is stored.
 */
async function verifySigned<T extends Signable>(body: unknown, expected: { host: string; deployment: string }, lookup: KeyLookup, now: number,
  what: string, parse: (message: string) => T | null, maxMs: number, longest: string) {
  const submission = appConsentSubmission.safeParse(body);
  if (!submission.success) throw new BadRequest(`Send the signed ${what}: message, nonce, publicKey and signature.`);
  const { message, nonce, publicKey, signature } = submission.data;
  const text = parse(message);
  if (!text) throw new BadRequest(`The ${what} text isn't a canonical app ${what}.`);
  if (text.host !== expected.host.toLowerCase()) throw new BadRequest(`The ${what} names another platform host.`);
  if (text.deployment !== expected.deployment) throw new BadRequest(`The ${what} names another app deployment.`);
  const expiresAt = Date.parse(text.expiresAt);
  if (expiresAt <= now + 60_000) throw new BadRequest(`The ${what} has expired or expires within a minute.`);
  if (expiresAt > now + maxMs) throw new BadRequest(`A ${what} lasts at most ${longest}.`);
  const nonceBytes = Buffer.from(nonce, "base64");
  if (nonceBytes.length !== 32) throw new BadRequest("The NEP-413 nonce must be 32 bytes.");
  let signed = false;
  try { signed = verifyEd25519(publicKey, nep413Hash(message, nonceBytes, text.host), signatureBytes(signature)); } catch { signed = false; }
  if (!signed) throw new BadRequest(`The signature doesn't match this ${what}.`, "signature_invalid");
  // A lookup that throws went unanswered: it propagates, so the route answers 503 instead of a refusal.
  const permission = await lookup(text.owner, publicKey);
  if (permission !== "FullAccess") throw new BadRequest(`${publicKey} is not a full-access key of ${text.owner}.`, "signature_invalid");
  return { text, expiresAt, signed: { id: hash(signatureBytes(signature).toString("hex")).toString("hex"), message, nonce, publicKey, signature } };
}

/** Checks a signed consent against this host and the calling deployment (`verifySigned`). */
export async function verifyConsent(body: unknown, expected: { host: string; deployment: string }, lookup: KeyLookup, now = Date.now()): Promise<VerifiedConsent> {
  const { text, expiresAt, signed } = await verifySigned(body, expected, lookup, now, "consent", parseConsentMessage, MAX_CONSENT_DAYS * DAY, `${MAX_CONSENT_DAYS} days`);
  return { version: 1, id: signed.id, deployment: text.deployment, host: text.host, organization: text.organization, owner: text.owner,
    agent: text.agent, agentId: text.agentId, scopes: text.scopes, expiresAt, message: signed.message, nonce: signed.nonce,
    publicKey: signed.publicKey, signature: signed.signature };
}

export const UNBORN = UNBORN_AGENT;
export const MAX_SETUP_MS = 3_600_000;

/** A verified setup request (`verifySigned`, at most an hour), before the platform reserves its agent. */
export async function verifySetup(body: unknown, expected: { host: string; deployment: string }, lookup: KeyLookup, now = Date.now()) {
  const { text, expiresAt, signed } = await verifySigned(body, expected, lookup, now, "setup", parseSetupMessage, MAX_SETUP_MS, "an hour");
  return { setup: text, expiresAt, signed };
}

/** The consent a verified setup gives for its reserved agent: `owner` scope, only while the agent isn't created. */
export function setupConsent(verified: Awaited<ReturnType<typeof verifySetup>>, agent: string): VerifiedConsent {
  const { setup, expiresAt, signed } = verified;
  return { version: 1, id: signed.id, deployment: setup.deployment, host: setup.host, organization: setup.organization, owner: setup.owner,
    agent, agentId: UNBORN, scopes: ["owner"], expiresAt, message: signed.message, nonce: signed.nonce, publicKey: signed.publicKey,
    signature: signed.signature };
}

export const MAX_CONSENTS_PER_DEPLOYMENT = 1_024;

/**
 * The app access log for the month of `at`: `access-YYYY-MM.jsonl` (UTC) beside the records. Every consent, call,
 * revocation, filing and confirmation is appended, synced, so it grows with use; a month's file is complete once the
 * month ends, and the operator may compress or move it then (docs/operations.md). Builds before 0.5.3 wrote one
 * `access.jsonl`, kept as it is.
 */
export const accessLog = (root: string, at = new Date()) => join(root, `access-${at.toISOString().slice(0, 7)}.jsonl`);

/** Parsed consent records by directory, shared by every `AppConsents` in this process. */
const consentCache = new Map<string, { stamp: string; records: ConsentRecord[] }>();

/** How long an ended consent's record stays among the live ones before `archive` moves it to `consents-ended/`. */
export const CONSENT_ARCHIVE_AFTER_MS = 30 * 86_400_000;

/**
 * Consents by id (the signature's hash). A revocation is a separate tombstone, `revoked/<id>`, that nothing deletes: a
 * revoked consent stays revoked even if its record is archived, and resubmitting its signature is refused. Expired
 * records are archived too; their text can never verify again. Every app call reads the consents, so the parsed records
 * are kept in memory, shared by every instance in this process, and read again after any of their own writes or when
 * the directory changes (a record stored, replaced or moved by another process: records are only ever replaced whole,
 * by rename, never edited in place). Only the gateway stores consents, so a coarse directory timestamp can't hide a
 * new one; a tombstone is checked on each read, so an operator's revocation from another process applies at once.
 */
export class AppConsents {
  private readonly dir: string;
  private readonly ended: string;
  private readonly tombstones: string;
  constructor(root: string) { this.dir = join(root, "consents"); this.ended = join(root, "consents-ended"); this.tombstones = join(root, "revoked"); }
  /** Every stored record, re-read after this process wrote one or after the directory changed. */
  private records() {
    let stamp: string;
    try { const stat = statSync(this.dir); stamp = `${stat.mtimeMs}:${stat.ctimeMs}`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const key = resolve(this.dir), cached = consentCache.get(key);
    if (cached?.stamp === stamp) return cached.records;
    const records = jsonFiles(this.dir).flatMap(file => readRecord(join(this.dir, file), Consent) ?? []);
    consentCache.set(key, { stamp, records });
    return records;
  }
  /** Writes a record whole, then drops this process's cached records, whatever the directory's timestamp says. */
  private write(id: string, record: ConsentRecord) {
    try { writeAtomic(join(this.dir, `${id}.json`), JSON.stringify(record) + "\n", 0o600); }
    finally { consentCache.delete(resolve(this.dir)); }
  }
  private withTombstone(record: ConsentRecord) { return this.isRevoked(record.id) && !record.revoked ? { ...record, revoked: true } : record; }
  private read(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) return null;
    const record = readRecord(join(this.dir, `${id}.json`), Consent);
    return record && this.withTombstone(record);
  }
  /** A consent stored here, live or archived: once stored, what it was is always answered the same. */
  find(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) return null;
    const live = this.read(id);
    if (live) return live;
    const archived = readRecord(join(this.ended, `${id}.json`), Consent);
    return archived && this.withTombstone(archived);
  }
  isRevoked(id: string) { return /^[a-f0-9]{64}$/.test(id) && existsSync(join(this.tombstones, id)); }
  /** Throws what `store` would refuse with, so a caller can check before acting on the consent. */
  admit(consent: VerifiedConsent, now = Date.now()) {
    if (this.isRevoked(consent.id)) throw new BadRequest("This consent was revoked. The owner can sign a new one.", "consent_revoked");
    if (this.read(consent.id)) return;
    // Revoked consents don't count: their tombstones already refuse their signatures.
    if (this.list({ deployment: consent.deployment }).filter(r => !r.revoked && r.expiresAt > now).length >= MAX_CONSENTS_PER_DEPLOYMENT)
      throw new BadRequest("This deployment has too many live consents. Revoke unused ones first.", "too_many_consents");
  }
  store(consent: VerifiedConsent, now = Date.now()) {
    this.admit(consent, now);
    const existing = this.read(consent.id);
    if (existing) return existing;
    privateDirectory(this.dir);
    const record = Consent.parse({ ...consent, createdAt: now, revoked: false, revokedAt: null });
    this.write(record.id, record);
    return record;
  }
  list(filter: { deployment?: string; organization?: string }) {
    return this.records().filter(r => (filter.deployment === undefined || r.deployment === filter.deployment) &&
      (filter.organization === undefined || r.organization === filter.organization)).map(r => this.withTombstone(r));
  }
  /**
   * Moves the records of consents that ended (revoked or expired) more than `after` ago into `consents-ended/`, keeping
   * every one, so the live directory stays bounded. Tombstones stay where they are and keep refusing revoked signatures.
   */
  archive(now = Date.now(), after = CONSENT_ARCHIVE_AFTER_MS) {
    // An ended record is never rewritten (`revoke` leaves an expired one's record alone), so moving it races no writer.
    const ended = this.records().map(r => this.withTombstone(r))
      .filter(r => Math.min(r.expiresAt, r.revoked ? r.revokedAt ?? r.expiresAt : Infinity) <= now - after);
    if (!ended.length) return [];
    privateDirectory(this.ended);
    try { return ended.filter(r => moveOnce(join(this.dir, `${r.id}.json`), join(this.ended, `${r.id}.json`))).map(r => r.id); }
    finally { consentCache.delete(resolve(this.dir)); }
  }
  /** The live consents covering this deployment, host, Organization and agent. */
  live(input: { deployment: string; host: string; organization: string; agent: string }, now = Date.now()) {
    return this.list(input).filter(r => !r.revoked && r.expiresAt > now && r.host === input.host.toLowerCase() && r.agent === input.agent);
  }
  /** Revokes a consent of this deployment on this host; the operator passes neither and may revoke any. */
  revoke(id: string, scope: { deployment: string; host: string } | null, now = Date.now(), reason = "revoked") {
    if (!/^[a-f0-9]{64}$/.test(id)) return false;
    const record = this.read(id);
    if (scope && (!record || record.deployment !== scope.deployment || record.host !== scope.host.toLowerCase())) return false;
    privateDirectory(this.tombstones);
    if (!this.isRevoked(id)) writeAtomic(join(this.tombstones, id), `${new Date(now).toISOString()} ${reason}\n`, 0o600);
    // The tombstone alone ends it; the record notes when, unless it had already expired (then it's final, and archived).
    if (record && !record.revokedAt && record.expiresAt > now) this.write(id, { ...record, revoked: true, revokedAt: now });
    return true;
  }
}

/**
 * Whether a consent's signing key still stands, revoking the consent for good when the chain says it doesn't: absent, or
 * no longer full-access. Removing a key is how an owner answers its compromise, so re-adding the same key later doesn't
 * revive consents it signed. A lookup that fails decides nothing and throws.
 */
export async function consentKeyHolds(consents: AppConsents, consent: ConsentRecord, keyState: KeyStateLookup, now = Date.now()) {
  const state = await keyState(consent.owner, consent.publicKey);
  if (state === "FullAccess") return true;
  consents.revoke(consent.id, null, now, state === "absent" ? "key-removed" : "key-not-full-access");
  return false;
}

/**
 * Checks every live wallet consent's key (operator sweep): catches a removal that no call happened to observe. A DAO's
 * consent is signed by its derived key, which is never one of the DAO account's keys: its ownership is re-read on every
 * call instead, so the sweep leaves it alone.
 */
export async function sweepConsentKeys(consents: AppConsents, keyState: KeyStateLookup, now = Date.now()) {
  const result = { checked: 0, revoked: [] as string[], unanswered: [] as string[] };
  for (const consent of consents.list({}).filter(c => !c.revoked && c.expiresAt > now && c.signer !== "dao")) {
    result.checked++;
    try { if (!await consentKeyHolds(consents, consent, keyState, now)) result.revoked.push(consent.id); }
    catch { result.unanswered.push(consent.id); }
  }
  return result;
}
