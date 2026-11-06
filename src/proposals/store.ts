import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { agentId } from "../env.js";
import { canonicalRecord } from "../mandate.js";
import { isHeld, isResolved, readOps } from "../ops.js";
import { createOnce, mkdirSynced } from "../synced.js";
import { proposalText, type ProposalState, type ProposalView } from "../contract/treasury-proposals.js";

/**
 * Treasury proposals' records (docs/enforcement.md, "Treasury proposals"), three files per proposal under
 * `.proposals/<agent id>/` (or, for one from before 0.5.3, `.proposals/` itself, read in place), each written once, whole
 * (`createOnce`). Hosted agents run side by side in one state directory; keyed by agent, like the journal, they share
 * no proposals, `requestId`s or open-proposal limit:
 * - `<id>.json`: the proposal and its sha256;
 * - `<id>.approval.json`: the owner's signature over its approval text;
 * - `<id>.final.json`: how it ended its waiting, one way only: claimed for execution (with the plan it runs, taken
 *   immediately before that plan's own claim), or closed (rejected, withdrawn, expired, invalidated, with why). Claiming
 *   and closing race for the same file, so a rejected proposal never executes and a claimed one is never closed.
 * Executing, executed, stopped and unknown are read from the claim and the journal, never stored.
 */
const ROOT = ".proposals";
const PROPOSAL = /^[a-f0-9]{32}\.json$/;

const leg = z.strictObject({ from: z.string(), to: z.string(), amount: z.string(), minAmountOut: z.string() });
export const ProposalRecord = z.strictObject({
  version: z.literal(1),
  id: z.string().regex(/^[a-f0-9]{32}$/),
  requestId: z.string(),
  /** The gateway's caller: `app:<deployment>:<organization>`. */
  actor: z.string(),
  /** The owner consent the app proposed under: another consent can't act on it. */
  consent: z.string(),
  deployment: z.string(),
  organization: z.string(),
  agentId: z.string(),
  source: z.enum(["external", "rebalance"]),
  /** What the app asked for, compared when the same `requestId` is asked again. */
  request: z.unknown(),
  legs: z.array(leg).min(1),
  quoted: z.array(z.strictObject({ amountOut: z.string(), costBps: z.number(), usdIn: z.number() })),
  policyRevision: z.number().nullable(),
  policyDigest: z.string().nullable(),
  strategyDigest: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  note: z.string().nullable(),
});
export type ProposalRecord = z.infer<typeof ProposalRecord>;
const Stored = z.strictObject({ proposal: ProposalRecord, sha256: z.string() });
export const Approval = z.strictObject({ message: z.string(), nonce: z.string(), publicKey: z.string(), signature: z.string(), host: z.string(), at: z.string() });
export type Approval = z.infer<typeof Approval>;
const Closed = z.strictObject({ state: z.enum(["rejected", "withdrawn", "expired", "invalidated"]), reason: z.string(), at: z.string(),
  signed: z.strictObject({ message: z.string(), nonce: z.string(), publicKey: z.string(), signature: z.string(), host: z.string() }).optional() });
export type Closed = z.infer<typeof Closed>;
const Final = z.union([Closed, z.strictObject({ state: z.literal("claimed"), planId: z.string(), at: z.string() })]);

const sha = (proposal: ProposalRecord) => createHash("sha256").update(canonicalRecord(proposal)).digest("hex");
const readJson = <T extends z.ZodType>(path: string, schema: T): z.output<T> | null =>
  existsSync(path) ? schema.parse(JSON.parse(readFileSync(path, "utf8"))) : null;

/** This agent's own directory, where every proposal from 0.5.3 on is written. */
const own = () => join(ROOT, agentId());

/**
 * Builds before 0.5.3 kept every hosted agent's proposals directly in `.proposals/`. They stay there, never moved, so a
 * rollback reads them as it left them and nothing about them can race a move: this agent reads its own (by the agent id
 * each records) in place, and writes their approval and final record beside them. Another agent's are never read here.
 */
function sharedOwn(id: string) {
  const path = join(ROOT, `${id}.json`);
  return existsSync(path) && readJson(path, Stored)?.proposal.agentId === agentId();
}

/** Where a proposal's files are: beside its record, which is this agent's own directory unless it predates 0.5.3. */
const directoryOf = (id: string) => existsSync(join(own(), `${id}.json`)) || !sharedOwn(id) ? own() : ROOT;
const file = (id: string, suffix: string) => join(directoryOf(id), `${id}${suffix}`);

/** A proposal's identity: the caller and its `requestId`, as for payout requests. */
export const proposalIdOf = (actor: string, requestId: string) =>
  createHash("sha256").update(`proposal\n${actor}\n${requestId}`).digest("hex").slice(0, 32);

/** The stored proposal, refusing one changed after it was written; null when there is none. */
export function loadProposal(id: string) {
  const stored = readJson(file(id, ".json"), Stored);
  if (!stored) return null;
  if (sha(stored.proposal) !== stored.sha256 || stored.proposal.id !== id) throw new Error(`Proposal ${id} was modified after it was saved`);
  return { record: stored.proposal, sha256: stored.sha256 };
}

/** Stores a new proposal; false when one with its id already exists. */
export function saveProposal(record: ProposalRecord) {
  mkdirSynced(ROOT);
  mkdirSynced(own());
  return createOnce(file(record.id, ".json"), JSON.stringify({ proposal: record, sha256: sha(record) }, null, 2));
}

export const readApproval = (id: string) => readJson(file(id, ".approval.json"), Approval);
export const saveApproval = (id: string, approval: Approval) => createOnce(file(id, ".approval.json"), JSON.stringify(approval));
export const readFinal = (id: string) => readJson(file(id, ".final.json"), Final);
/** Closes a proposal neither claimed nor closed; false if it already ended its waiting. */
export const close = (id: string, closed: Closed) => createOnce(file(id, ".final.json"), JSON.stringify(closed));
/** Claims a proposal for the plan that executes it; false if it was claimed or closed before. */
export const claim = (id: string, planId: string) =>
  createOnce(file(id, ".final.json"), JSON.stringify({ state: "claimed", planId, at: new Date().toISOString() }));

/** This agent's proposals: those in its own directory, and its own from before 0.5.3 still in the shared one. */
export function proposalIds() {
  const ids = (dir: string) => existsSync(dir) ? readdirSync(dir).filter(name => PROPOSAL.test(name)).map(name => name.slice(0, 32)) : [];
  const mine = ids(own());
  return [...mine, ...ids(ROOT).filter(id => !mine.includes(id) && sharedOwn(id))];
}

/** Proposals whose execution is running in this process: read as `executing`, not from an unfinished journal. */
export const running = new Set<string>();

/** What the records and the journal prove about a proposal, never more. */
export function proposalState(record: ProposalRecord, now = Date.now()) {
  const { id } = record;
  const final = readFinal(id);
  if (final?.state === "claimed") {
    const { planId } = final;
    const ops = readOps().filter(op => op.planId === planId);
    const operations = ops.map(op => ({ method: op.method, status: op.status ?? null, correlationId: op.correlationId ?? null, refused: op.refused ?? null }));
    const succeeded = ops.filter(op => op.method === "swap" && op.status === "SUCCESS").length;
    const state: ProposalState = running.has(id) ? "executing"
      : ops.some(op => !isResolved(op)) ? "unknown"
      : succeeded === record.legs.length && ops.every(op => op.status === "SUCCESS") ? "executed"
      : "stopped";
    const reason = state === "stopped" && !ops.length ? "claimed, and nothing was sent"
      : state === "unknown" && ops.some(isHeld) ? "a swap is held by the provider for the owner's vote" : null;
    return { state, reason, planId, operations };
  }
  if (final) return { state: final.state as ProposalState, reason: final.reason, planId: null, operations: [] };
  if (now >= Date.parse(record.expiresAt)) return { state: "expired" as const, reason: "its validity ended", planId: null, operations: [] };
  return { state: (readApproval(id) ? "approved" : "proposed") as ProposalState, reason: null, planId: null, operations: [] };
}

export function proposalView(record: ProposalRecord, sha256: string, now = Date.now()): ProposalView {
  const { actor: _actor, consent: _consent, request: _request, version: _version, ...terms } = record;
  return { ...terms, sha256, approvedAt: readApproval(record.id)?.at ?? null, ...proposalState(record, now) };
}

/** The text the owner signs for this proposal. */
export const textOf = (record: ProposalRecord, sha256: string, verdict: "approve" | "reject") => proposalText({ ...record, sha256 }, verdict);
