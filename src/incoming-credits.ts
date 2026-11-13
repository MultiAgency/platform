import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, openSync, closeSync, fsyncSync, linkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { z } from "zod";

const text = z.string().trim().min(1).max(500);
const time = z.iso.datetime({ offset: true });
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const incomingCredit = z.strictObject({
  agent: text, recipient: text, asset: text, amount: z.string().max(100).regex(/^[1-9]\d*$/), settledAt: time,
  source: z.strictObject({ issuer: z.url().refine(s => { const u = new URL(s); return u.protocol === "https:" && !u.username && !u.password; }).transform(s => new URL(s).origin), receiptId: text }),
  // Shared settlement identifiers, not amount/time similarity, establish overlap with later provider history.
  correlationId: text.optional(), intentHash: text.optional(), providerOrigin: z.url().optional(),
  recordedBy: text, recordedAt: time,
  evidence: z.enum(["operator-receipt", "provider-status"]),
}).refine(c => c.evidence !== "provider-status" || !!c.correlationId && !!c.intentHash && !!c.providerOrigin, "Provider-backed credits require operation, intent and provider origin");
export type IncomingCredit = z.infer<typeof incomingCredit>;
const stored = z.strictObject({ version: z.literal(1), credit: incomingCredit, receiptBase64: z.string().max(1_400_000), receiptSha256: z.string().regex(/^[a-f0-9]{64}$/), hash: z.string().regex(/^[a-f0-9]{64}$/) });
const identity = (c: IncomingCredit) => JSON.stringify([c.source.issuer, c.source.receiptId]);
const directory = (agent: string, root: string) => join(root, hash(agent));
function syncDirectories(dir: string) {
  let path = resolve(dir);
  for (let i = 0; i < 4; i++) {
    const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    path = dirname(path);
  }
}
const independentlyIdentified = (a: IncomingCredit, b: IncomingCredit) =>
  !!(a.correlationId && b.correlationId && a.correlationId !== b.correlationId || a.intentHash && b.intentHash && a.intentHash !== b.intentHash);
const fingerprint = (c: IncomingCredit) => JSON.stringify([c.agent, c.recipient, c.asset, c.amount, Date.parse(c.settledAt)]);
function check(record: z.infer<typeof stored>) {
  const { hash: digest, ...body } = record;
  if (hash(JSON.stringify(body)) !== digest || hash(Buffer.from(record.receiptBase64, "base64")) !== record.receiptSha256)
    throw new Error("Incoming-credit evidence integrity check failed; preserve the record");
  return record;
}
export function readIncomingCredits(agent: string, root = ".evidence/incoming-credits"): IncomingCredit[] {
  const dir = directory(agent, root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => n.endsWith(".json")).map(n => {
    let record: z.infer<typeof stored>;
    try { record = check(stored.parse(JSON.parse(readFileSync(join(dir, n), "utf8")))); }
    catch { throw new Error("Incoming-credit evidence unavailable or failed integrity checks; preserve its records"); }
    if (record.credit.agent !== agent || n !== `${hash(identity(record.credit))}.json`) throw new Error("Incoming-credit record binding mismatch");
    return record.credit;
  });
}
/** Additive accounting evidence only. Caller must stop the executor and hold its money lock; no operation is sent. */
export function recordIncomingCredit(input: IncomingCredit, receipt: Buffer, root = ".evidence/incoming-credits") {
  const credit = incomingCredit.parse(input);
  if (!receipt.length || receipt.length > 1_000_000) throw new Error("A funding receipt of at most 1 MB is required");
  if (Date.parse(credit.settledAt) > Date.parse(credit.recordedAt)) throw new Error("A future credit cannot be recorded");
  const existing = readIncomingCredits(credit.agent, root);
  for (const prior of existing) {
    const same = identity(prior) === identity(credit) || prior.correlationId && prior.correlationId === credit.correlationId || prior.intentHash && prior.intentHash === credit.intentHash;
    if (same) {
      if (fingerprint(prior) !== fingerprint(credit)) throw new Error("Conflicting incoming-credit evidence; original record retained");
      // The caller may repeat an identical import, never replace evidence under its receipt identity.
      if (identity(prior) === identity(credit)) {
        const record = check(stored.parse(JSON.parse(readFileSync(join(directory(credit.agent, root), `${hash(identity(prior))}.json`), "utf8"))));
        if (record.receiptSha256 !== hash(receipt)) throw new Error("Receipt changed under an existing credit identity");
      }
      syncDirectories(directory(credit.agent, root));
      return { created: false, credit: prior };
    }
  }
  if (existing.some(p => fingerprint(p) === fingerprint(credit) && !independentlyIdentified(p, credit)))
    throw new Error("Possible duplicate credit with another receipt identity; bind a shared settlement identifier before recording");
  const dir = directory(credit.agent, root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = { version: 1 as const, credit, receiptBase64: receipt.toString("base64"), receiptSha256: hash(receipt) };
  const record = { ...body, hash: hash(JSON.stringify(body)) };
  // Publish a whole record once. A crash before publication leaves only an ignored temporary file.
  const tmp = join(dir, `${hash(identity(credit))}.${randomUUID()}.tmp`), file = join(dir, `${hash(identity(credit))}.json`);
  const fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(record) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(tmp, file); } finally { unlinkSync(tmp); }
  syncDirectories(dir);
  return { created: true, credit };
}

export type ExecutionCredit = { asset: string | null; amount: string | null; correlationId: string; intentHash: string | null };
/** Provider execution records win. An ambiguous overlap is unavailable accounting, never another credit. */
export function additionalIncomingCredits(credits: IncomingCredit[], executions: ExecutionCredit[], recipient: string) {
  const totals = new Map<string, bigint>(), accepted: IncomingCredit[] = [];
  for (const c of credits) {
    if (c.recipient !== recipient) throw new Error("Incoming credit names another recipient wallet");
    const matches = executions.filter(e => e.correlationId === c.correlationId || !!c.intentHash && e.intentHash === c.intentHash);
    if (matches.length) {
      if (matches.length !== 1 || matches[0]!.asset !== c.asset || matches[0]!.amount !== c.amount || !!c.intentHash && !!matches[0]!.intentHash && c.intentHash !== matches[0]!.intentHash) throw new Error("Provider and receipt credit evidence conflict");
      continue;
    }
    // A receipt number alone cannot establish that later provider records describe another payment.
    // Even with one identifier, a provider entry that omits that identifier cannot prove non-overlap.
    if (executions.some(e => e.asset === null || e.amount === null || e.asset === c.asset && (!c.correlationId && !c.intentHash || !c.correlationId && !e.intentHash)))
      throw new Error("Incoming-credit overlap is unproven; bind the provider settlement before counting the receipt");
    if (accepted.some(p => identity(p) === identity(c) || p.correlationId && p.correlationId === c.correlationId || p.intentHash && p.intentHash === c.intentHash))
      throw new Error("Duplicate incoming-credit settlement");
    accepted.push(c); totals.set(c.asset, (totals.get(c.asset) ?? 0n) + BigInt(c.amount));
  }
  return { totals, accepted };
}
