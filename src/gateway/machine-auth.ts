import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { BadRequest } from "../http.js";
import { writeAtomic } from "../synced.js";
import { mayCall } from "./allowlist.js";
import type { Access } from "./roles.js";

export const MachineScope = z.enum(["read", "prepare", "execute-plan", "sweep"]);
export type MachineScope = z.infer<typeof MachineScope>;
export const MachineIssue = z.strictObject({
  label: z.string().trim().min(1).max(80),
  scopes: z.array(MachineScope).min(1).max(4).refine(values => new Set(values).size === values.length),
  ttlSeconds: z.number().int().min(60).max(86_400).default(3_600),
});
const Record = MachineIssue.omit({ ttlSeconds: true }).extend({
  version: z.literal(2), id: z.uuid(), secretHash: z.string().regex(/^[a-f0-9]{64}$/),
  account: z.string().min(2), owner: z.string().min(2), agent: z.string().regex(/^[a-z0-9-]{1,32}$/),
  agentId: z.string().min(1),
  host: z.string().min(1), createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
  revoked: z.boolean(),
}).strict();
// Earlier experimental records remain listable/revocable, but can never authorize a call.
const LegacyRecord = Record.omit({ agentId: true }).extend({ version: z.literal(1), scopes: z.array(z.enum(["read", "prepare", "execute"])).min(1).max(3) });
const StoredRecord = z.discriminatedUnion("version", [Record, LegacyRecord]);
type Credential = z.infer<typeof StoredRecord>;
const publicRecord = <T extends Credential>({ secretHash: _hash, ...record }: T) => record;
const hash = (value: string) => createHash("sha256").update(value).digest();

/** Deliberately narrower than dashboard reads: no staged-grant adoption or owner-action work. */
const READ = new Set(["instance", "overview", "summary", "policyHistory", "strategy/get", "autopilot/get", "activity", "unresolved", "autopilot/evidence", "autopilot/log", "ledger", "ledgerCsv"]);
const PREPARE = new Set(["rebalance", "externalPlan"]);
export function machineMayCall(scopes: readonly MachineScope[], access: Access, path: string) {
  return mayCall(access, path) && ((scopes.includes("read") && READ.has(path)) || (scopes.includes("prepare") && PREPARE.has(path)) ||
    (scopes.includes("execute-plan") && path === "executePlan") || (scopes.includes("sweep") && path === "sweep"));
}

/** One gateway process owns this additive state. Reload each request so revocation survives restart. */
export class MachineCredentials {
  constructor(private readonly root: string) {}
  private read(id: string): Credential | null {
    if (!z.uuid().safeParse(id).success) return null;
    let text: string;
    try { text = readFileSync(join(this.root, `${id}.json`), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const record = StoredRecord.parse(JSON.parse(text));
    if (record.id !== id || record.expiresAt <= record.createdAt) throw new Error("Invalid machine credential record");
    return record;
  }
  issue(input: z.infer<typeof MachineIssue> & { account: string; owner: string; agent: string; agentId: string; host: string }, now = Date.now()) {
    const parsed = MachineIssue.parse({ label: input.label, scopes: input.scopes, ttlSeconds: input.ttlSeconds });
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const parent = openSync(dirname(this.root), "r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
    if ((statSync(this.root).mode & 0o077) !== 0) throw new Error("Machine credential directory must be private");
    if (readdirSync(this.root).filter(name => name.endsWith(".json")).length >= 1_024) throw new BadRequest("Machine credential storage is full. Archive expired or revoked records before issuing more.");
    const id = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const record = Record.parse({ version: 2, id, secretHash: hash(secret).toString("hex"), account: input.account,
      owner: input.owner, agent: input.agent, agentId: input.agentId, host: input.host.toLowerCase(), label: parsed.label,
      scopes: parsed.scopes, createdAt: now, expiresAt: now + parsed.ttlSeconds * 1_000, revoked: false });
    writeAtomic(join(this.root, `${id}.json`), JSON.stringify(record) + "\n", 0o600);
    return { credential: publicRecord(record), token: `tmc_${id}.${secret}` };
  }
  authenticate(authorization: string | undefined, host: string, now = Date.now()) {
    const match = authorization?.match(/^Bearer tmc_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/);
    if (!match) return null;
    const record = this.read(match[1]!);
    if (!record || record.version !== 2 || record.revoked || now >= record.expiresAt || record.host !== host.toLowerCase()) return null;
    return timingSafeEqual(hash(match[2]!), Buffer.from(record.secretHash, "hex")) ? publicRecord(record) : null;
  }
  list(agent: string, owner: string) {
    let files: string[];
    try { files = readdirSync(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return files.filter(file => file.endsWith(".json")).map(file => this.read(file.slice(0, -5)))
      .filter((record): record is Credential => record !== null && record.agent === agent && record.owner === owner).map(publicRecord);
  }
  revoke(id: string, agent: string, owner: string) {
    const record = this.read(id);
    if (!record || record.agent !== agent || record.owner !== owner) return false;
    writeAtomic(join(this.root, `${id}.json`), JSON.stringify({ ...record, revoked: true }) + "\n", 0o600);
    return true;
  }
}
