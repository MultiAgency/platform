import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import { readJson, sendJson as json, serveStatic } from "../http.js";
import { nep413Hash, signatureBytes, verifyEd25519 } from "../nep413.js";
import { ownerSignatureProblem } from "../owner-signature.js";
import { appendSynced, writeAtomic } from "../synced.js";
import type { AgentEntry } from "./config.js";
import { forwardRpc } from "./rpc-proxy.js";
import { privateDirectory, readRecord } from "./app-access.js";

/**
 * Confirm pages: a NEP-366 owner action an app prepared is held here, not handed to the app, and the owner signs it on
 * the platform's own page, which shows the platform's record of the action. The link shows the terms to whoever holds
 * it, the app included; the bytes to sign go only to a visitor who first signs the link's text with the owner's key,
 * text that tells the owner in the wallet to sign it only on this page. Only the owner's signature over those bytes
 * submits, once. Additive state under `.app-access/confirm/`: one record per link, named by the token's hash; a hold marker per
 * held action, named by its correlation ID's hash; and a claim file beside the record once a submission was made.
 */
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** Whether a file exists; anything but its absence is an error, never a "no". */
const present = (file: string) => {
  try { closeSync(openSync(file, "r")); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
};
const TOKEN = /^[A-Za-z0-9_-]{22}$/;

const Confirm = z.strictObject({ version: z.literal(1), id: z.string().regex(/^[a-f0-9]{64}$/), deployment: z.string(), host: z.string(),
  organization: z.string(), owner: z.string(), agent: z.string(), agentId: z.string().nullable(), consent: z.string(),
  correlationId: z.string().min(1), type: z.string(), action: z.record(z.string(), z.unknown()),
  /** The agent's own record of a creation's or edit's policy: what it asked the provider to sign, and what it replaces. */
  policy: z.looseObject({ current: z.unknown(), requested: z.unknown() }).nullable(), summary: z.string().nullable(), expiresAt: z.string(),
  intent: z.looseObject({ standard: z.literal("nep366"), payload: z.record(z.string(), z.unknown()) }),
  signer: z.looseObject({ type: z.literal("near"), account_id: z.string(), public_key: z.string() }),
  /** The 32-byte NEP-413 nonce of the link's opening text. */
  nonce: z.string(), createdAt: z.number().int(), submittedAt: z.number().int().nullable() });
export type ConfirmRecord = z.infer<typeof Confirm>;

/**
 * The text the owner signs to open a link. It carries its own warning, so the wallet shows it wherever the owner is
 * asked: signed on any page but the platform's, it lets that page ask for a signature over a hidden action.
 */
export const confirmOpenMessage = (record: ConfirmRecord) => [
  "Open a MultiAgency confirm page.",
  `Sign this only on https://${record.host}/confirm/. If any other page asks you to sign it, refuse: that page could then ask you to sign an owner action it hides from you.`,
  `Link: ${record.id}`, `App deployment: ${record.deployment}`, `Organization: ${record.organization}`, `Agent: ${record.agent}`,
  `Action: ${record.type}`, `Expires: ${record.expiresAt}`,
].join("\n");

export class AppConfirms {
  private readonly dir: string;
  constructor(root: string) { this.dir = join(root, "confirm"); }
  private file(id: string, extension = "json") { return join(this.dir, `${id}.${extension}`); }
  read(token: string) {
    if (!TOKEN.test(token)) return null;
    const record = readRecord(this.file(hash(token)), Confirm);
    return record && { ...record, submittedAt: record.submittedAt ?? (this.claimed(record.id) ? record.createdAt : null) };
  }
  hold(input: Omit<ConfirmRecord, "version" | "id" | "nonce" | "createdAt" | "submittedAt">, now = Date.now()) {
    privateDirectory(this.dir);
    const token = randomBytes(16).toString("base64url");
    const record = Confirm.parse({ ...input, version: 1, id: hash(token), nonce: randomBytes(32).toString("base64"), createdAt: now, submittedAt: null });
    writeAtomic(this.file(hash(record.correlationId), "hold"), `${record.id}\n`, 0o600);
    writeAtomic(this.file(record.id), JSON.stringify(record) + "\n", 0o600);
    return { token, record };
  }
  /** Whether an action held here: its owner signs it on the confirm page, never through the app. */
  holds(correlationId: string) { return present(this.file(hash(correlationId), "hold")); }
  private claimed(id: string) { return present(this.file(id, "claim")); }
  /** Takes the one submission a link allows: an exclusive, durable claim file, before anything is forwarded. */
  claim(record: ConfirmRecord, now = Date.now()) {
    let fd: number;
    try { fd = openSync(this.file(record.id, "claim"), "wx", 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
    try { writeSync(fd, `${new Date(now).toISOString()}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    writeAtomic(this.file(record.id), JSON.stringify({ ...record, submittedAt: now }) + "\n", 0o600);
    return true;
  }
}

/**
 * The confirm page's own asset paths (scripts, styles, fonts), from the web build's manifest (rsbuild's
 * `build-manifest.json`): what a headless host serves beside the page. None when the build has no manifest.
 */
export function confirmAssets(dist: string): Set<string> {
  let entry: { initial?: { js?: string[]; css?: string[] }; async?: { js?: string[]; css?: string[] }; assets?: string[] } | undefined;
  try { entry = JSON.parse(readFileSync(join(dist, "build-manifest.json"), "utf8")).entries?.confirm; } catch { return new Set(); }
  return new Set([...entry?.initial?.js ?? [], ...entry?.initial?.css ?? [], ...entry?.async?.js ?? [], ...entry?.async?.css ?? [], ...entry?.assets ?? []]);
}

const opening = z.object({ signature: z.string() });
/** Whether a body is the owner key's NEP-413 signature over the link's opening text (the key the action names). */
function opensLink(record: ConfirmRecord, body: unknown) {
  const parsed = opening.safeParse(body);
  if (!parsed.success) return false;
  try {
    return verifyEd25519(record.signer.public_key, nep413Hash(confirmOpenMessage(record), Buffer.from(record.nonce, "base64"), record.host),
      signatureBytes(parsed.data.signature));
  } catch { return false; }
}

/**
 * The confirm page (`/confirm/<token>`) and its browser calls under `/confirm/v1/<token>`: read the terms, open (the
 * owner's signature over the link's text releases the bytes to sign), and submit.
 */
export async function confirmRoutes(req: IncomingMessage, res: ServerResponse, pathname: string, host: string, confirms: AppConfirms, root: string,
  selected: AgentEntry[], dist: string, stopping: () => boolean): Promise<boolean> {
  const page = pathname.match(/^\/confirm\/([A-Za-z0-9_-]{22})$/);
  if (page) {
    if (!["GET", "HEAD"].includes(req.method ?? "")) { json(res, 405, { error: "Use GET" }); return true; }
    await serveStatic(res, dist, "/confirm.html"); return true;
  }
  const call = pathname.match(/^\/confirm\/v1\/([A-Za-z0-9_-]{22})(\/open)?$/);
  if (!call) return false;
  // A link belongs to the host the app called: its opening text names that host, and no other host serves it.
  const found = confirms.read(call[1]!);
  const record = found?.host === host.toLowerCase() ? found : null;
  if (!record) { json(res, 404, { error: "No such confirmation. Ask the app for a new link." }); return true; }
  const expired = Date.parse(record.expiresAt) <= Date.now();
  const used = () => json(res, 409, { error: "A submission was already made from this link. The app follows its outcome; if it failed, the app prepares the action again." });
  if (req.method === "GET" && !call[2]) {
    json(res, 200, { deployment: record.deployment, organization: record.organization, agent: record.agent, owner: record.owner,
      type: record.type, action: record.action, policy: record.policy, summary: record.summary, expiresAt: record.expiresAt,
      signer: { account_id: record.signer.account_id, public_key: record.signer.public_key },
      opening: { message: confirmOpenMessage(record), recipient: record.host, nonce: record.nonce },
      state: record.submittedAt !== null ? "submitted" : expired ? "expired" : "open" });
    return true;
  }
  if (req.method !== "POST") { json(res, 405, { error: "Use GET or POST" }); return true; }
  if (record.submittedAt !== null) { used(); return true; }
  if (expired) { json(res, 410, { error: "This action expired unsigned. Ask the app to prepare it again." }); return true; }
  const body = await readJson(req);
  if (call[2]) {
    if (!opensLink(record, body)) { json(res, 403, { error: "Sign this link's text with the owner's key to see what to sign." }); return true; }
    json(res, 200, { intent: record.intent }); return true;
  }
  const agent = selected.find(a => a.name === record.agent);
  if (!agent || stopping()) { json(res, 503, { error: "The agent isn't available now. Nothing was submitted." }); return true; }
  const submission = z.object({ signedData: z.record(z.string(), z.unknown()) }).safeParse(body);
  if (!submission.success) { json(res, 400, { error: "Send the wallet's signed data." }); return true; }
  // Checked here first, so a wrong wallet or other bytes leave the link usable for the owner's own signature.
  const problem = ownerSignatureProblem(record.intent as never, record.signer, submission.data.signedData);
  if (problem) { json(res, 400, { error: `Not submitted: ${problem}.` }); return true; }
  if (!confirms.claim(record)) { used(); return true; }
  appendSynced(join(root, "access.jsonl"), { at: new Date().toISOString(), deployment: record.deployment, event: "confirmed",
    consent: record.consent, organization: record.organization, owner: record.owner, agent: record.agent, action: record.type, correlationId: record.correlationId });
  forwardRpc(req, res, agent, "owner/submit", undefined, JSON.stringify({ json: { correlationId: record.correlationId, signedData: submission.data.signedData } }),
    `app:${record.deployment}:${record.organization}`);
  return true;
}
