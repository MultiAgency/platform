import { ORPCError } from "@orpc/server";
import { assertNotReleased } from "./release-state.js";
import { PublicError } from "./public-error.js";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type Intent, type OwnerWallet, type Policy, type SubmitIntentRequest } from "@near-intents-agent-api/sdk";
import { api, readStatus } from "./api.js";
import { completeSigning, type DaoSigning, daoOwner, findSignature, latestBlock, proposalAndVote, proposalTransaction, signingRequest, signTransaction } from "./dao-owner.js";
import { agentId, ENV_FILE, executes, saveEnv } from "./env.js";
import { appendSynced, writeAtomic } from "./synced.js";

import { type GrantLabel, grantRequest, promoteGrantToken, stageGrantToken } from "./grants.js";
import { ASSETS } from "./contract/assets.js";
import { loadStrategy } from "./strategy.js";
import { type Strategy, strategyLabelSuffix } from "./strategy-digest.js";
import { ownerRequests, type PolicyChanges, policyChange } from "./owner-requests.js";
import type { AgentRole } from "./policy.js";
import { daoPolicy, nextProposalId } from "./chain.js";
import { canonicalPolicy, mandateDigest, type ReviewedPolicy } from "./mandate.js";
import { isTerminal, settle } from "./ops.js";
import { checkPaymentApproval, type PaymentApproval } from "./payment-approval.js";
import { repeatPayouts } from "./repeat-payouts.js";
import { acquireMoneyLock, assertMoneyLock } from "./lock.js";
import { ownerSignatureProblem } from "./owner-signature.js";
import { checkHostedCreation } from "./hosted-binding.js";

/**
 * Owner actions, signed by the owner's browser wallet or by a DAO. The server prepares each with
 * the API key; a wallet signs the payload exactly as generated, while a DAO files one proposal
 * asking its MPC key to sign the payload's hash, and the server submits that signature once the
 * vote passes. The API key and the grant token never reach the browser.
 */

export type OwnerAction =
  | { type: "agent_create"; owner?: OwnerWallet; role?: AgentRole; payees?: string[] }
  | { type: "grant_issue"; label?: GrantLabel; suffix?: string; expectedStrategyDigest?: string; expiresAt?: string }
  /** Stops one grant at once; operations it already committed still finish. */
  | { type: "grant_revoke"; grantId: string }
  | { type: "agent_freeze" }
  | { type: "agent_unfreeze" }
  /** The provider's reversible retirement: it needs a frozen agent and changes nothing on chain (`agent_restore` reverses it). */
  | { type: "agent_archive" }
  | { type: "agent_restore" }
  | { type: "policy_update"; changes: PolicyChanges; expectedPolicy: ReviewedPolicy }
  /** Releases (or rejects) one held money action: `correlationId` is that execution's. */
  | { type: "approval_vote"; approvalId: string; verdict: "approve" | "reject"; correlationId: string };

type Signer = "wallet" | "dao";

type Prepared = { stage?: "prepared" | "submitted" | "settled"; result?: { status: string; failureCode?: string | null }; ownerSucceeded?: boolean; type: string; expiresAt: string; grantToken?: string; releases?: string; dao?: DaoSigning; paymentApproval?: PaymentApproval;
  /** For a wallet's signature: what was prepared and who must sign it, checked before the signature is relayed. */
  wallet?: { intent: Intent; signer: OwnerWallet };
  /** The owner's signature as submitted, kept to send again if the API never received it. */
  signedData?: Record<string, unknown> };

/** An unsubmitted intent's signing window has closed: the API refuses it from this moment, so every view says so too. */
const windowClosed = (expiresAt: string, now = Date.now()) => now >= Date.parse(expiresAt);
/** Where a stored intent stands, read one way. Each view below only names these phases in its own contract's words. */
const phaseOf = (saved: Pick<Prepared, "stage" | "expiresAt">, now = Date.now()) =>
  saved.stage === "settled" ? "settled" as const : saved.stage === "submitted" ? "submitted" as const
    : windowClosed(saved.expiresAt, now) ? "expired" as const : "open" as const;

/** What one owner action holds against a second: votes per held payout, freeze and unfreeze together, every other action by its type. */
const actionKind = (type: string, approvalId?: string) =>
  type === "approval_vote" ? `approval_vote:${approvalId}` : type === "agent_unfreeze" ? "agent_freeze" : type;
/** A submitted action, or a DAO's vote still open, holds its kind; a wallet's unsigned intent holds nothing. */
const holds = (saved: Pick<Prepared, "stage" | "expiresAt" | "dao">) => {
  const phase = phaseOf(saved);
  return phase === "submitted" || (phase === "open" && saved.dao !== undefined);
};

/**
 * Durable prepared, submitted and settled intents. They are kept in a file per
 * instance, so a restart forgets neither a DAO vote in progress nor the grant token it would issue.
 * The file holds grant tokens: it is as private as the settings file.
 */
const PENDING_FILE = join(".owner-intents", `${basename(ENV_FILE)}.json`);
const contradictoryPreparation = (record: { stage?: string; signedData?: unknown; ownerSucceeded?: boolean; result?: unknown }) =>
  (record.stage === undefined || record.stage === "prepared") &&
  (record.signedData !== undefined || record.ownerSucceeded === true || record.result !== undefined);
const isSettledOwnerResult = (result: Prepared["result"]) => result !== undefined &&
  (isTerminal(result.status) || (result.status === "EXPIRED" && result.failureCode === "signing_window_closed"));
const lifecycle = z.object({
  type: z.string().min(1),
  expiresAt: z.string().refine(value => Number.isFinite(Date.parse(value))),
  stage: z.enum(["prepared", "submitted", "settled"]).optional(),
  ownerSucceeded: z.boolean().optional(),
  result: z.object({ status: z.string().min(1), failureCode: z.string().nullable().optional() }).optional(),
  signedData: z.record(z.string(), z.unknown()).optional(),
}).passthrough().superRefine((record, context) => {
  // Legacy unsigned preparations omitted stage. A retained signature or outcome makes that
  // interpretation ambiguous; never reconstruct a first submission from contradictory evidence.
  if (contradictoryPreparation(record))
    context.addIssue({ code: "custom", message: "An unsigned preparation contains submission or outcome evidence" });
  if (record.stage === "settled" && !isSettledOwnerResult(record.result))
    context.addIssue({ code: "custom", message: "A settled owner action has no proven outcome" });
});
const storedIntents = z.record(z.string().min(1), lifecycle);
function readPending() {
  if (!existsSync(PENDING_FILE)) return new Map<string, Prepared>();
  try {
    const records = JSON.parse(readFileSync(PENDING_FILE, "utf8"));
    storedIntents.parse(records);
    // Validate without projecting away signing material or legacy optional fields.
    return new Map<string, Prepared>(Object.entries(records));
  } catch {
    throw new Error(`Owner-intent history unavailable (${basename(PENDING_FILE)}); preserve and verify the records before continuing.`);
  }
}
let pending = new Map<string, Prepared>();

// CLI recovery saves settings directly. A running server installs its lease-and-loop activation path.
let configureCreatedAgent = async (id: string) => { saveEnv({ AGENT_ID: id }); };
export function setAgentCreationHandler(handler: (id: string) => Promise<void>) { configureCreatedAgent = handler; }

// Validate the fields this cross-instance check relies on; legacy records may omit stage.
const pendingDelegate = z.object({
  type: z.string().min(1),
  expiresAt: z.string().refine(value => Number.isFinite(Date.parse(value))),
  stage: z.enum(["prepared", "submitted", "settled"]).optional(),
  ownerSucceeded: z.boolean().optional(),
  result: z.object({ status: z.string().min(1), failureCode: z.string().nullable().optional() }).optional(),
  signedData: z.record(z.string(), z.unknown()).optional(),
  dao: z.object({ owner: z.object({ account_id: z.string().min(1) }), delegate: z.string().min(1).optional() }).optional(),
}).refine(record => !contradictoryPreparation(record), "An unsigned preparation contains submission or outcome evidence");
const peerIntents = z.record(z.string(), pendingDelegate);

/**
 * A NEAR delegate action (NEP-366) waiting for a vote or with an unproven submission under `owner`, from any agent's
 * server on this host. The owner key has one nonce sequence: whichever delegate action executes raises
 * it, so a second one prepared meanwhile would fail after its own vote. Each server keeps its pending
 * intents beside the others in `.owner-intents/`; another host's (a laptop's) aren't visible here.
 */
export function delegateWaiting(owner: string, now = Date.now()): z.infer<typeof pendingDelegate> | undefined {
  if (!existsSync(".owner-intents")) return undefined;
  for (const name of readdirSync(".owner-intents").filter((n) => n.endsWith(".json"))) {
    let entries: z.infer<typeof pendingDelegate>[];
    try { entries = Object.values(peerIntents.parse(JSON.parse(readFileSync(join(".owner-intents", name), "utf8")))); }
    catch { throw new Error(`Owner-intent history unavailable (${name}); preserve and verify the records before preparing another delegate action.`); }
    const waiting = entries.find((p) => {
      if (!p.dao?.delegate || p.dao.owner.account_id !== owner) return false;
      const stage = p.stage ?? "prepared";
      if (stage === "prepared") return !windowClosed(p.expiresAt, now);
      // Approval completion is separate from settlement of the payout it released.
      if (p.ownerSucceeded === true) return false;
      if (stage === "submitted") return true; // expiry or a newer nonce read is not an outcome
      return !isSettledOwnerResult(p.result);
    });
    if (waiting) return waiting;
  }
  return undefined;
}
let assertOwnerLock: () => void = () => { throw new Error("Owner-intent storage requires its lock"); };
let ownerQueue: Promise<unknown> = Promise.resolve();

/** Lock order: instance storage, then owner key. Never acquire a peer instance's lock here.
 * All participating instances must share this directory on one host. */
async function withDelegateLock<T>(owner: string, run: (assertHeld: () => void) => Promise<T>): Promise<T> {
  const key = createHash("sha256").update(owner).digest("hex");
  const path = join(".owner-intents", `.delegate-${key}`);
  let held = true;
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(path, { realpath: false, retries: 0, stale: 10_000, update: 2_000,
      onCompromised: () => { held = false; } });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED")
      throw new ORPCError("CONFLICT", { message: "Another owner action is preparing a delegate; retry after it finishes.", data: { kind: "busy" } });
    throw error;
  }
  const assertHeld = () => { if (!held) throw new PublicError("Owner delegate preparation lock lost; refresh before preparing again."); };
  try { assertHeld(); return await run(assertHeld); }
  finally { if (held) { held = false; await release(); } }
}

/** Serialize the full read/modify/write lifecycle, including async status/signature checks.
 * Reload only after acquiring the cross-process lock. Atomic rename alone cannot merge stale maps.
 * Like the money lock this is single-host coordination, not distributed fencing. */
export function withOwnerLock<T>(run: (assertCurrent: () => void) => Promise<T>): Promise<T> {
  const next = ownerQueue.then(async () => {
    mkdirSync(dirname(PENDING_FILE), { recursive: true, mode: 0o700 });
    let held = true;
    const release = await lockfile.lock(PENDING_FILE, {
      realpath: false, stale: 10_000,
      retries: { retries: 100, minTimeout: 100, maxTimeout: 100 },
      onCompromised: () => { held = false; },
    });
    assertOwnerLock = () => { if (!held) throw new Error("Owner-intent storage lock lost"); };
    try {
      pending = readPending();
      if (expire() || [...pending.values()].some((p) => p.grantToken && (p.ownerSucceeded || p.stage === "settled"))) savePending();
      return await run(assertOwnerLock);
    } finally {
      const owned = held;
      held = false;
      if (owned) await release();
    }
  });
  ownerQueue = next.catch(() => undefined);
  return next;
}

/** How each DAO-signed intent ended, for the page to follow. */
const outcomes = new Map<
  string,
  { stage: "submitting" | "submitted" | "expired" | "failed"; status?: string; failureCode?: string | null; error?: string }
>();

function savePending() {
  assertOwnerLock();
  // A grant token is kept only until it is in the settings file (promoted) or can no longer be (settled):
  // after that, a copy here would only be one more place a live credential could leak from.
  for (const prepared of pending.values()) if (prepared.ownerSucceeded || prepared.stage === "settled") delete prepared.grantToken;
  mkdirSync(dirname(PENDING_FILE), { recursive: true });
  writeAtomic(PENDING_FILE, JSON.stringify(Object.fromEntries(pending)), 0o600);
}

/** Drops intents past the API's signing window, a DAO's recorded as expired for the page; true if any. */
function expire() {
  let dropped = false;
  for (const [correlationId, { dao, expiresAt, stage, type, paymentApproval }] of pending) {
    if (phaseOf({ stage, expiresAt }) !== "expired") continue;
    pending.delete(correlationId);
    // Answered `expired` while this process runs; a DAO's is also archived, so it stays known after a restart.
    outcomes.set(correlationId, { stage: "expired" });
    if (dao) {
      // Kept so a proposal filed for it can still be recognised once its signing window has closed.
      mkdirSync(dirname(EXPIRED_FILE), { recursive: true });
      appendSynced(EXPIRED_FILE, { correlationId, type, expiresAt, hash: dao.hash, intent: dao.intent, delegate: dao.delegate ?? null, payment: paymentOf(paymentApproval) });
    }
    dropped = true;
  }
  return dropped;
}

/** An approval vote names the held payment it releases or rejects: how a proposal links to its payment. */
const paymentOf = (approval?: PaymentApproval) => (approval ? { correlationId: approval.correlationId, verdict: approval.verdict } : null);

/** DAO signing requests whose window closed before the vote passed: what they were, nothing secret. */
const EXPIRED_FILE = join(".owner-intents", `${basename(ENV_FILE)}.expired.jsonl`);

function hold(correlationId: string, prepared: Prepared) {
  assertOwnerLock();
  if (pending.has(correlationId)) throw new Error("Owner intent identity already recorded");
  expire();
  pending.set(correlationId, { ...prepared, stage: "prepared" });
  savePending();
}

async function build(
  action: OwnerAction,
): Promise<{ request: Parameters<typeof api.generateIntent>[0]; grantToken?: string; releases?: string; current?: Awaited<ReturnType<typeof policyChange>>["current"] }> {
  switch (action.type) {
    case "agent_create":
      // Onboarding creates the server's one agent; it never replaces a configured one.
      if (process.env.AGENT_ID) throw new Error("An agent is already configured");
      if (!action.owner) throw new Error("agent_create needs an owner");
      return { request: ownerRequests.agent_create(action.owner, action.role, action.payees) };
    case "grant_issue": {
      // The new grant's token is saved where it is prepared: only the agent's executor may hold it.
      if (!executes()) throw new PublicError("This copy only reads and approves: issue the grant from the agent's executor, which must hold its token");
      const { token, request } = await grantRequest({ label: action.label, suffix: action.suffix, expectedStrategyDigest: action.expectedStrategyDigest, expiresAt: action.expiresAt, requireStrategyReview: true });
      return { request, grantToken: token };
    }
    case "grant_revoke":
      return { request: { type: "grant_revoke", agent_id: agentId(), grant_id: action.grantId } as const };
    case "policy_update":
      return policyChange(action.changes, action.expectedPolicy);
    case "approval_vote": {
      const { approvalId, verdict, correlationId } = action;
      const request = { type: "approval_vote", agent_id: agentId(), approval_id: approvalId, verdict } as const;
      return { request, releases: correlationId };
    }
    default:
      return { request: ownerRequests[action.type]() };
  }
}

/** The linked treasury's owner account, when the treasury is a DAO signing as owner. */
async function treasuryOwner() {
  const dao = process.env.TREASURY_ACCOUNT;
  if (!dao) throw new Error("Link the DAO as the treasury first");
  return daoOwner(dao);
}

export function prepare(action: OwnerAction, signer: Signer = "wallet") {
  return withOwnerLock(() => prepareLocked(action, signer));
}

async function prepareLocked(action: OwnerAction, signer: Signer) {
  assertNotReleased();
  if (signer === "dao" && (action.type === "agent_archive" || action.type === "agent_restore")) throw new PublicError("Archive and restore through apps currently support wallet owners only.");
  if (process.env.HOSTED_OWNER && action.type === "agent_create" && [...pending.values()].some(p => p.type === "agent_create" && p.stage !== "settled"))
    // Coded, so an app whose prepare reply was lost can tell this apart and find the open action (`owner/pending`).
    throw new ORPCError("CONFLICT", { message: "Agent creation already has an open owner action. Follow its existing record (owner/pending) before preparing another.",
      data: { kind: "refused", code: "owner_action_open" } });
  const kind = actionKind(action.type, action.type === "approval_vote" ? action.approvalId : undefined);
  if ([...pending.values()].some(p => actionKind(p.type, p.paymentApproval?.approvalId) === kind && holds(p)))
    throw new ORPCError("CONFLICT", { message: "An owner action of this kind is already submitted or awaiting the DAO's vote. Follow its existing record (owner/pending) before preparing another.",
      data: { kind: "refused", code: "owner_action_open" } });
  const vote = action.type === "approval_vote" ? await checkPaymentApproval(action) : undefined;
  const paymentApproval = vote?.binding;
  // Earlier payouts of the same terms, shown to the owner beside them; it never refuses (src/repeat-payouts.ts).
  const repeats = vote?.terms ? await repeatPayouts(vote.terms, action.type === "approval_vote" ? action.correlationId : "") : undefined;
  const owner = signer === "dao" ? await treasuryOwner() : undefined;
  if (action.type === "agent_create" && (owner ?? action.owner))
    checkHostedCreation((owner ?? action.owner)!, signer, action.role);
  const { request, grantToken, releases, current } = await build(action.type === "agent_create" && owner ? { ...action, owner } : action);
  const generated = await api.generateIntent(request, { idempotencyKey: crypto.randomUUID() });
  if (generated.type !== request.type) throw new Error("Provider generated a different owner intent type");
  if (paymentApproval && (generated.preview.approval?.approval_id !== paymentApproval.approvalId ||
      generated.preview.approval.request_hash !== paymentApproval.requestHash || generated.preview.approval.verdict !== paymentApproval.verdict))
    throw new Error("Generated approval does not bind the verified payment");
  // The mandate this signature asks for, as the server requested it. Whether the signed payload
  // commits to it is the API's to prove: a NEP-366 edit carries the policy encrypted.
  const digest = request.type === "policy_update" ? mandateDigest(request.policy) : null;
  // The policy this signature asks for, as this server built the request, and the one in force it replaces.
  const policies = "policy" in request ? { current: current ?? null, requested: request.policy } : undefined;
  // A grant as this server asked for it: the owner reviews its label and when it ends, apart from the signing window.
  const grant = request.type === "grant_issue" ? { label: request.label, expiresAt: request.expires_at } : undefined;
  const base = { correlationId: generated.correlation_id, preview: generated.preview, expiresAt: generated.expires_at, digest,
    ...(policies && { policy: policies }), ...(grant && { grant }), ...(paymentApproval && { payment: { ...paymentOf(paymentApproval)!, terms: vote!.terms, ...(repeats && { repeats }) } }) };

  if (!owner) {
    const wallet = { intent: generated.intent, signer: generated.signer };
    hold(generated.correlation_id, { type: generated.type, expiresAt: generated.expires_at, grantToken, releases, paymentApproval, wallet });
    return { ...base, intent: generated.intent, signer: generated.signer };
  }
  if (generated.signer.type !== "near" || generated.signer.account_id !== owner.account_id)
    throw new Error("This agent's owner is not the DAO's owner account");
  const buildAndHold = async (assertHeld: () => void) => {
    if (generated.intent.standard === "nep366") {
      const waiting = delegateWaiting(owner.account_id);
      if (waiting) {
        if ((waiting.stage ?? "prepared") !== "prepared")
          throw new Error(`Another owner action (${waiting.type}) has an unresolved delegate submission. Reconcile its existing record before preparing another.`);
        throw new Error(`Another owner action (${waiting.type}) is waiting for the DAO's vote until ${waiting.expiresAt}. Finish or let it expire before preparing another delegate.`);
      }
    }
    // Read before the proposal is filed, so its signature can only come later.
    const dao = { ...(await signingRequest(generated.intent, owner)), since: await latestBlock() };
    assertHeld();
    hold(generated.correlation_id, { type: generated.type, expiresAt: generated.expires_at, grantToken, releases, dao, paymentApproval });
    return dao;
  };
  const dao = generated.intent.standard === "nep366"
    ? await withDelegateLock(owner.account_id, buildAndHold)
    : await buildAndHold(assertOwnerLock);
  watch();
  const daoId = process.env.TREASURY_ACCOUNT!;
  // The intent is already held: a failed read only drops the one-click filings, leaving filing in Trezu.
  const [policy, nextId] = await Promise.all([daoPolicy(daoId).catch(() => null), nextProposalId(daoId).catch(() => null)]);
  // A grant's proposal names the strategy it binds; a strategy that can't be read now leaves only its digest suffix.
  const label = grant?.label;
  let strategy: Strategy | undefined;
  if (label?.startsWith("treasury:")) try { strategy = loadStrategy(); } catch { strategy = undefined; }
  // A revocation's proposal names the grant it ends, read from the provider; an unreadable list names only its id.
  const revokes = request.type === "grant_revoke" ? { id: request.grant_id,
    label: (await api.listGrants(agentId()).catch(() => null))?.find(g => g.grant_id === request.grant_id)?.label ?? null } : undefined;
  const description = proposalDescription({ type: generated.type, summary: generated.preview.summary, expiresAt: generated.expires_at, hash: dao.hash, label, strategy,
    grantExpiresAt: grant?.expiresAt, revokes, policy: policies });
  return {
    ...base,
    dao: {
      owner: owner.account_id,
      transaction: signTransaction(dao.hash),
      // For a member filing it from their own wallet: the same request, described.
      proposal: policy ? proposalTransaction(daoId, dao.hash, description, policy.proposal_bond) : null,
      // For a member who may also vote: filed and approved in one confirmation.
      proposalAndVote: policy && nextId !== null ? proposalAndVote(daoId, dao.hash, description, policy.proposal_bond, nextId) : null,
    },
  };
}

/**
 * What a DAO proposal says it does; proposals are public. A policy update's provider summary may name
 * the payees it adds, so it gets fixed wording and the dashboard shows what it does. Approvals already
 * read generically ("Approve the pending confidential request", #46–#53 on chain). A Treasury grant (label
 * `treasury:<suffix>`) lets the agent swap within the strategy it binds without a vote each time, so its proposal says
 * so and names that strategy's terms, when `strategy` is the one the suffix binds.
 */
export function proposalDescription(intent: { type: string; summary: string; expiresAt: string; hash: string; label?: string; strategy?: Strategy;
  grantExpiresAt?: string; revokes?: { id: string; label: string | null }; policy?: { current: Policy | null; requested: Policy } }) {
  // A DAO's proposals are public: a policy edit's summary can name payees, so it's never used.
  const action = intent.type === "policy_update" ? "Change the agent's policy" : intent.summary;
  const suffix = intent.type === "grant_issue" && intent.label?.startsWith("treasury:") ? intent.label.slice("treasury:".length) : undefined;
  const terms = suffix === undefined ? null : !intent.strategy ? "its terms couldn't be read when this was filed; read them on the agent before voting"
    : strategyLabelSuffix(intent.strategy) === suffix ? strategyTerms(intent.strategy)
    : "the saved strategy changed after this grant was prepared; read the one this suffix names on the agent before voting";
  return [
    `* Proposal Action: ${action}`,
    ...(suffix !== undefined ? [
      "* Authorizes: the agent's autopilot, and plans of apps the DAO consented to with treasury-execute, to swap without " +
        "a vote each time, within the strategy below and the DAO's signed policy. The DAO's approved Treasury proposals also execute under it",
      `* Strategy ${suffix}: ${terms}`] : []),
    ...(intent.grantExpiresAt ? [`* Grant expires: ${intent.grantExpiresAt} (the provider refuses the agent's sends under it after then)`] : []),
    ...(intent.revokes ? [intent.revokes.label === null
      ? `* Revokes: grant ${intent.revokes.id}, not found among the agent's grants when this was filed; check it on the agent before voting`
      : `* Revokes: grant ${intent.revokes.id} (${intent.revokes.label})`,
      ...(intent.revokes.label?.startsWith("treasury") ? ["* Ends: swaps without a vote under this grant (the autopilot, and plans of apps with treasury-execute)"] : [])] : []),
    ...(intent.type === "policy_update" && intent.policy ? [`* Changes: ${policyChanges(intent.policy.current, intent.policy.requested)}`] : []),
    `* Agent: ${process.env.AGENT_ID ?? "a new agent"}`,
    `* Signing window closes: ${intent.expiresAt} (approve before then, or the signature can't be used)`,
    `* Signs: hash ${intent.hash} as the agents' owner (v1.signer, path agent-owner)`,
    "* Notes: Filed by the MultiAgency platform. Before voting, check that the proposal's v1.signer call signs exactly this hash (payload_v2.Eddsa).",
  ].join(" <br>");
}

/**
 * The policy fields the edit changes, by name only: a DAO's proposals are public, and values can name payees or the
 * DAO's budget. Members see each field before and after where only they can: `owner/prepare` answers both policies.
 */
function policyChanges(current: Policy | null, requested: Policy) {
  if (!current) return "the policy in force couldn't be read when this was filed; compare it on the agent before voting";
  const before = JSON.parse(canonicalPolicy(current)) as Record<string, unknown>, after = JSON.parse(canonicalPolicy(requested)) as Record<string, unknown>;
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .filter(field => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null));
  return fields.length ? `${fields.join(", ")} (values aren't published here: compare each before and after where your app shows it to members)`
    : "none: the requested policy equals the one in force";
}

const assetNames = new Map(Object.entries(ASSETS).map(([name, id]) => [id as string, name]));
/** A strategy's terms in plain words, for the DAO members who vote on the grant that binds it. */
const strategyTerms = (strategy: Strategy) => [
  `targets ${Object.entries(strategy.targetBps).map(([asset, bps]) => `${assetNames.get(asset) ?? asset} ${bps / 100}%`).join(", ")}`,
  `each swap costs at most ${strategy.maxCostBps / 100}% of its input`,
  `drift under $${strategy.minLegUsd} is left alone`,
  `autopilot runs every ${strategy.autopilot.everyMin} min and executes at most $${strategy.autopilot.maxUsd} per run`,
  ...(strategy.cashFloor ? [`cash floor $${strategy.cashFloor.usd} in ${strategy.cashFloor.assets.map((asset) => assetNames.get(asset) ?? asset).join(" and ")}: ` +
    "a swap that would take these under it is refused, one that adds to them never is"] : []),
].join("; ");

/**
 * Apply local effects before marking settled; each effect is safe to repeat after a crash. An intent
 * the API still holds as `PENDING_SIGNATURE` never received the signature: it is sent again while the
 * window is open (the API documents resubmitting the same signature as safe), so a lost request
 * doesn't waste a DAO's vote, and ends as `EXPIRED` once the window has closed.
 */
async function reconcileOne(correlationId: string, prepared: Prepared) {
  if (prepared.stage === "settled") return prepared.result!;
  let owner = prepared.ownerSucceeded && prepared.releases ? undefined : await readStatus(correlationId);
  if (owner?.status === "PENDING_SIGNATURE") {
    if (windowClosed(prepared.expiresAt)) {
      prepared.stage = "settled";
      prepared.result = { status: "EXPIRED", failureCode: "signing_window_closed" };
      savePending();
      return prepared.result;
    }
    // Submitted before signatures were kept: nothing to send again, so it is polled until the window closes.
    if (prepared.signedData && prepared.type !== "approval_vote") {
      await sendSignature(correlationId, prepared, prepared.signedData);
      owner = await readStatus(correlationId);
    }
  }
  assertOwnerLock();
  if (owner?.status === "SUCCESS" && !prepared.ownerSucceeded) {
    if (prepared.type === "agent_create") {
      if (!owner.agent_id) throw new Error("Successful creation has no agent id; recovery remains blocked");
      await configureCreatedAgent(owner.agent_id);
    }
    if (prepared.grantToken) promoteGrantToken(prepared.grantToken);
    if (prepared.type === "agent_restore" && process.env.RESTORE_REQUIRED === agentId()) saveEnv({ RESTORE_REQUIRED: "" });
    prepared.ownerSucceeded = true;
    savePending();
  }
  const result = prepared.ownerSucceeded && prepared.releases
    ? await readStatus(prepared.releases)
    : owner;
  if (!result) throw new Error("Missing owner outcome");
  assertOwnerLock();
  if (prepared.ownerSucceeded && prepared.releases) settle(prepared.releases, result.status);
  const answer = { status: result.status, failureCode: result.failure_code };
  if (isTerminal(result.status)) {
    prepared.stage = "settled";
    prepared.result = answer;
    savePending();
  }
  return answer;
}

const sendSignature = async (correlationId: string, prepared: Prepared, signedData: Record<string, unknown>) => {
  assertNotReleased();
  assertOwnerLock();
  if (prepared.type !== "approval_vote") return api.submitIntent({ type: prepared.type, correlation_id: correlationId, signed_data: signedData } as SubmitIntentRequest);
  if (!prepared.paymentApproval) throw new Error("Legacy approval has no exact payment binding; prepare a new vote");
  const lock = await acquireMoneyLock({ reconcile: true });
  try {
    if (prepared.stage === "submitted" || prepared.stage === "settled") throw new PublicError("Approval submission already attempted; poll its existing intent");
    const checked = await checkPaymentApproval(prepared.paymentApproval, prepared.paymentApproval);
    assertMoneyLock(lock);
    prepared.stage = "submitted";
    prepared.signedData = signedData;
    savePending();
    watch();
    checked.assertCurrent();
    return await api.submitIntent({ type: prepared.type, correlation_id: correlationId, signed_data: signedData } as SubmitIntentRequest);
  } finally { await lock.release(); }
};

/**
 * Persist before the request, signature included: after a crash or lost response, polling decides.
 * The signature is sent again only if the API says it never arrived (see `reconcileOne`).
 */
export function submit(correlationId: string, signedData: Record<string, unknown>) {
  return withOwnerLock(() => submitLocked(correlationId, signedData, "wallet"));
}

/**
 * `from`: who signed. A wallet's signature arrives from the browser and is checked here against what
 * was prepared; a DAO's is found on chain, already verified against the prepared hash (`findSignature`).
 */
async function submitLocked(correlationId: string, signedData: Record<string, unknown>, from: "wallet" | "dao") {
  assertNotReleased();
  assertOwnerLock();
  const prepared = pending.get(correlationId);
  if (!prepared) throw new PublicError("Unknown intent");
  if (prepared.stage === "settled") return prepared.result!;
  if (prepared.stage === "submitted") return reconcileOne(correlationId, prepared);
  if (windowClosed(prepared.expiresAt)) throw new PublicError("Intent expired");
  if (from === "dao") {
    if (!prepared.dao) throw new Error("This intent wasn't prepared for a DAO's signature");
  } else {
    if (!prepared.wallet) throw new PublicError("This intent wasn't prepared for a wallet's signature: prepare it again");
    const problem = ownerSignatureProblem(prepared.wallet.intent, prepared.wallet.signer, signedData);
    if (problem) throw new Error(`Not submitted: ${problem}`);
  }
  if (prepared.grantToken) stageGrantToken(prepared.grantToken);
  if (prepared.type !== "approval_vote") {
    prepared.stage = "submitted";
    prepared.signedData = signedData;
    savePending();
    watch();
  }
  await sendSignature(correlationId, prepared, signedData);
  return reconcileOne(correlationId, prepared);
}

/** One bounded polling pass. A failed read cannot prevent recovery of another intent. */
export function reconcileOwnerIntents() {
  return withOwnerLock(reconcileLocked);
}

async function reconcileLocked() {
  const results = [];
  for (const [correlationId, prepared] of pending) {
    if (prepared.stage !== "submitted") continue;
    try {
      results.push({ correlationId, ...(await reconcileOne(correlationId, prepared)) });
    } catch (error) {
      results.push({ correlationId, status: "UNKNOWN", error: String(error) });
    }
  }
  return results;
}

/** Where a DAO-signed intent stands: waiting for the vote, or how it ended. */
export function status(correlationId: string) {
  const saved = readPending().get(correlationId);
  // After a restart an expired DAO intent is known only from its archive.
  const phase = saved ? phaseOf(saved)
    : outcomes.get(correlationId)?.stage === "expired" || archivedIds().has(correlationId) ? "expired" as const : undefined;
  return { ...stageOf(correlationId, saved, phase), ...(phase && { phase }) };
}

/** `owner/status`'s own words for a phase, kept for clients before 0.5.5; the in-memory `outcomes` say more while this process follows a vote. */
function stageOf(correlationId: string, saved: Prepared | undefined, phase: ReturnType<typeof phaseOf> | undefined) {
  if (phase === "settled") return { stage: "submitted" as const, ...saved!.result };
  if (phase === "submitted") return { stage: "submitting" as const };
  const outcome = outcomes.get(correlationId);
  if (outcome) return outcome;
  if (phase === "expired") return { stage: "expired" as const };
  if (saved?.dao) return { stage: "voting" as const, expiresAt: saved.expiresAt };
  return { stage: "unknown" as const };
}

/** Private display projection of durable owner actions; never includes signing material. */
export function ownerActions(now = Date.now()) {
  return [...readPending()].reverse().map(([correlationId, saved]) => {
    const phase = phaseOf(saved, now);
    return {
      correlationId,
      type: saved.type,
      expiresAt: saved.expiresAt,
      signer: saved.dao ? "dao" as const : "wallet" as const,
      stage: phase === "open" ? "prepared" as const : phase,
      phase,
      ownerSucceeded: saved.ownerSucceeded === true,
      status: saved.result?.status ?? null,
      failureCode: saved.result?.failureCode ?? null,
      payment: paymentOf(saved.paymentApproval),
    };
  });
}

/**
 * Everything this server asked the DAO to sign, with where each stands: still waiting for the vote,
 * done (the signature arrived and was submitted), or expired (the API's window closed first). A
 * member checks a v1.signer proposal against it before voting. Nothing secret: no grant token, no
 * signature.
 */
export function daoRequests(now = Date.now()) {
  const kept = [...readPending()].flatMap(([correlationId, { type, expiresAt, dao, stage, paymentApproval }]) => {
    if (!dao) return [];
    const phase = phaseOf({ stage, expiresAt }, now);
    const state = phase === "open" ? "waiting" : phase === "expired" ? "expired" : "done";
    return [{ correlationId, type, expiresAt, hash: dao.hash, intent: dao.intent, delegate: dao.delegate ?? null, state, payment: paymentOf(paymentApproval), phase }];
  });
  const expired = archivedExpired(lines => lines.slice(-100)).map(archived => ({ ...archived, state: "expired" as const, phase: "expired" as const }));
  return [...kept, ...expired];
}

/** The archive's correlation IDs, read again only when the file changed: `owner/status` asks on every poll. */
let archived: { stamp: string; ids: Set<string> } | undefined;
function archivedIds() {
  if (!existsSync(EXPIRED_FILE)) return new Set<string>();
  const { size, mtimeMs } = statSync(EXPIRED_FILE), stamp = `${size}:${mtimeMs}`;
  if (archived?.stamp !== stamp) archived = { stamp, ids: new Set(archivedExpired(lines => lines).map(entry => entry.correlationId)) };
  return archived.ids;
}

/**
 * DAO intents dropped when their window closed, oldest first, from the archive lines `select` keeps: only those are
 * parsed, since the archive only grows. Lines archived before payments were recorded carry none; a torn last line is skipped.
 */
function archivedExpired(select: (lines: string[]) => string[]) {
  if (!existsSync(EXPIRED_FILE)) return [];
  return select(readFileSync(EXPIRED_FILE, "utf8").split("\n").filter(Boolean)).flatMap((line) => {
    try {
      const archived = JSON.parse(line) as { correlationId: string; type: string; expiresAt: string; hash: string; intent: DaoSigning["intent"];
        delegate: string | null; payment?: ReturnType<typeof paymentOf> };
      return [{ ...archived, payment: archived.payment ?? null }];
    } catch { return []; }
  });
}

let watching: NodeJS.Timeout | undefined;
let busy = false;
/** Looks for each pending DAO signature every 10 seconds and submits it once the vote passes. */
function watch() {
  watching ??= setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await followDaoVotes();
    } catch (error) {
      console.error("Owner reconciliation deferred:", String(error));
    } finally {
      busy = false;
    }
  }, 10_000);
  watching.unref();
}

/** One pass: polls submitted intents, and submits each DAO signature that a passed vote produced. */
export function followDaoVotes() {
  return withOwnerLock(async () => {
    await reconcileLocked();
    for (const [correlationId, prepared] of pending) {
      const { dao, stage } = prepared;
      if (!dao || stage === "submitted" || stage === "settled") continue;
      const daoId = process.env.TREASURY_ACCOUNT;
      const signature = daoId ? await findSignature(daoId, dao).catch(() => null) : null;
      if (!signature) continue;
      outcomes.set(correlationId, { stage: "submitting" });
      try {
        outcomes.set(correlationId, { stage: "submitted", ...(await submitLocked(correlationId, completeSigning(dao, signature), "dao")) });
      } catch (error) {
        // The durable submitted state prevents the next tick from sending again.
        if (pending.has(correlationId)) outcomes.delete(correlationId);
        else outcomes.set(correlationId, { stage: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    }
  });
}

// At load: drop expired intents, and grant tokens kept by records written before they were dropped on save.
await withOwnerLock(async () => undefined);

/** At server start: a DAO vote that was in progress when the server stopped is followed again. */
export function resumeOwnerIntents() {
  // Another process may prepare a DAO action after this server starts.
  watch();
}
