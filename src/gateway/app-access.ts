import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { RPCSerializer } from "@orpc/client";
import { z } from "zod";
import { ownerPrepareInput } from "../contract/inputs.js";
import { BadRequest } from "../http.js";
import { nep413Hash, signatureBytes, verifyEd25519 } from "../nep413.js";
import type { KeyLookup, KeyStateLookup } from "../signin.js";
import { writeAtomic } from "../synced.js";
import { AppScope, appConsentSubmission, parseConsentMessage, parseSetupMessage, UNBORN_AGENT } from "../contract/app-consent.js";
import { appMayAsk, appScopesCover } from "../contract/app-access.js";
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
export function appMayPrepare(input: unknown) {
  let decoded: unknown;
  try { decoded = rpcInput.deserialize(input as Parameters<RPCSerializer["deserialize"]>[0]); } catch { return null; }
  const parsed = ownerPrepareInput.safeParse(decoded);
  return parsed.success && parsed.data.signer === "wallet" && appMayAsk(parsed.data.action) ? parsed.data.action : null;
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
const jsonFiles = (dir: string) => {
  try { return readdirSync(dir).filter(file => file.endsWith(".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
};

const Credential = z.strictObject({ version: z.literal(1), id: z.uuid(), secretHash: z.string().regex(/^[a-f0-9]{64}$/),
  deployment, host: z.string().min(1), label: z.string().trim().min(1).max(80), createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(), revoked: z.boolean() });
type Credential = z.infer<typeof Credential>;
const publicCredential = ({ secretHash: _hash, ...record }: Credential) => record;

/** Service credentials: one per app deployment and host, issued and revoked by the platform operator. */
export class AppCredentials {
  private readonly dir: string;
  constructor(root: string) { this.dir = join(root, "credentials"); }
  private read(id: string) {
    if (!z.uuid().safeParse(id).success) return null;
    return readRecord(join(this.dir, `${id}.json`), Credential);
  }
  issue(input: { deployment: string; host: string; label: string; days: number }, now = Date.now()) {
    if (!Number.isInteger(input.days) || input.days < 1 || input.days > MAX_CREDENTIAL_DAYS) throw new BadRequest(`Choose 1 to ${MAX_CREDENTIAL_DAYS} days.`);
    privateDirectory(this.dir);
    const id = randomUUID(), secret = randomBytes(32).toString("base64url");
    const record = Credential.parse({ version: 1, id, secretHash: hash(secret).toString("hex"), deployment: input.deployment,
      host: input.host.toLowerCase(), label: input.label, createdAt: now, expiresAt: now + input.days * DAY, revoked: false });
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
}

const Consent = z.strictObject({ version: z.literal(1), id: z.string().regex(/^[a-f0-9]{64}$/), deployment, host: z.string().min(1),
  organization: z.string(), owner: z.string(), agent: z.string(), agentId: z.string().min(1), scopes: z.array(AppScope).min(1),
  expiresAt: z.number().int().positive(), createdAt: z.number().int().nonnegative(), message: z.string(), nonce: z.string(),
  publicKey: z.string(), signature: z.string(), revoked: z.boolean(), revokedAt: z.number().int().nullable() });
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
  if (!signed) throw new BadRequest(`The signature doesn't match this ${what}.`);
  // A lookup that throws went unanswered: it propagates, so the route answers 503 instead of a refusal.
  const permission = await lookup(text.owner, publicKey);
  if (permission !== "FullAccess") throw new BadRequest(`${publicKey} is not a full-access key of ${text.owner}.`);
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
 * Consents by id (the signature's hash). A revocation is a separate tombstone, `revoked/<id>`, that nothing deletes: a
 * revoked consent stays revoked even if its record is archived, and resubmitting its signature is refused. Expired
 * records may be archived; their text can never verify again.
 */
export class AppConsents {
  private readonly dir: string;
  private readonly tombstones: string;
  constructor(root: string) { this.dir = join(root, "consents"); this.tombstones = join(root, "revoked"); }
  private read(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) return null;
    const record = readRecord(join(this.dir, `${id}.json`), Consent);
    return record && (this.isRevoked(id) && !record.revoked ? { ...record, revoked: true } : record);
  }
  isRevoked(id: string) { return /^[a-f0-9]{64}$/.test(id) && existsSync(join(this.tombstones, id)); }
  /** Throws what `store` would refuse with, so a caller can check before acting on the consent. */
  admit(consent: VerifiedConsent, now = Date.now()) {
    if (this.isRevoked(consent.id)) throw new BadRequest("This consent was revoked. The owner can sign a new one.");
    if (this.read(consent.id)) return;
    if (this.list({ deployment: consent.deployment }).filter(r => r.expiresAt > now).length >= MAX_CONSENTS_PER_DEPLOYMENT)
      throw new BadRequest("This deployment has too many unexpired consents. Revoke unused ones first.");
  }
  store(consent: VerifiedConsent, now = Date.now()) {
    this.admit(consent, now);
    const existing = this.read(consent.id);
    if (existing) return existing;
    privateDirectory(this.dir);
    const record = Consent.parse({ ...consent, createdAt: now, revoked: false, revokedAt: null });
    writeAtomic(join(this.dir, `${record.id}.json`), JSON.stringify(record) + "\n", 0o600);
    return record;
  }
  list(filter: { deployment?: string; organization?: string }) {
    return jsonFiles(this.dir).map(file => this.read(file.slice(0, -5))).filter((r): r is ConsentRecord =>
      r !== null && (filter.deployment === undefined || r.deployment === filter.deployment) && (filter.organization === undefined || r.organization === filter.organization));
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
    if (record && !record.revokedAt) writeAtomic(join(this.dir, `${id}.json`), JSON.stringify({ ...record, revoked: true, revokedAt: now }) + "\n", 0o600);
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

/** Checks every live consent's key (operator sweep): catches a removal that no call happened to observe. */
export async function sweepConsentKeys(consents: AppConsents, keyState: KeyStateLookup, now = Date.now()) {
  const result = { checked: 0, revoked: [] as string[], unanswered: [] as string[] };
  for (const consent of consents.list({}).filter(c => !c.revoked && c.expiresAt > now)) {
    result.checked++;
    try { if (!await consentKeyHolds(consents, consent, keyState, now)) result.revoked.push(consent.id); }
    catch { result.unanswered.push(consent.id); }
  }
  return result;
}
