import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { sendRefusal } from "../agent.js";
import { api } from "../api.js";
import { notInForce } from "../authorize.js";
import { agentId, executes } from "../env.js";
import { liveGrant } from "../grants.js";
import { mandateDigest } from "../mandate.js";
import { nep413Hash, signatureBytes, verifyEd25519 } from "../nep413.js";
import { executePlan, type Observed, type PlanEvent } from "../planning/execution.js";
import { quoteChosen, type ChosenSwap } from "../planning/external.js";
import type { Plan } from "../planning/model.js";
import { observe } from "../planning/observation.js";
import { heldOutgoing } from "../ops.js";
import { assertNotStopping } from "../lock.js";
import { savePlan } from "../planning/store.js";
import { PublicError } from "../public-error.js";
import { loadStrategy } from "../strategy.js";
import { strategyDigest } from "../strategy-digest.js";
import { planBreaksCashFloor } from "../strategy-value.js";
import { planLegs, planSteps, quoteLeg } from "../treasury.js";
import { MAX_OPEN_PROPOSALS, MAX_PROPOSAL_MS, proposalCreateInput, proposalRef, proposalSignature, proposalSigned } from "../contract/treasury-proposals.js";
import type { CallContext } from "../rpc/base.js";
import { claim, close, loadProposal, proposalIdOf, proposalIds, proposalState, proposalView, readApproval, readFinal, running, saveApproval,
  saveProposal, textOf, type ProposalRecord } from "./store.js";

/**
 * Treasury proposals through an app (docs/enforcement.md, "Treasury proposals"): the app proposes, the owner signs the
 * exact terms later, the app asks for execution. Execution saves a plan from fresh quotes and runs it through
 * `executePlan`, whose every send goes through `dispatch`; the proposal is claimed under the money lock after all
 * checks, immediately before the plan's own claim, so a refused attempt claims nothing and a claimed proposal never
 * runs twice.
 */

const refused = (code: string, message: string) => new ORPCError("BAD_REQUEST", { message, data: { kind: "refused", code } });
const ACTOR = /^app:([a-z0-9-]{1,32}):([A-Za-z0-9_-]{1,128})$/;

/**
 * Only an app, through the gateway, on the agent's executor. The gateway names the caller (`app:<deployment>:<organization>`),
 * the owner consent the call came under, and the host it was made on.
 */
function caller({ actor, consent, host, consents }: CallContext) {
  const match = actor?.match(ACTOR);
  if (!match || !consent || !/^[a-f0-9]{64}$/.test(consent) || !host || !consents?.includes(consent))
    throw new PublicError("Treasury proposals are made through an app. Nothing was stored.");
  // Proposals are stored and executed only on the executor: an approve-only copy would answer for records it can't see.
  if (!executes()) throw new PublicError("This copy only approves: ask the agent's executor about proposals. Nothing was stored.");
  return { actor: actor!, consent, host, consents: consents!, deployment: match[1]!, organization: match[2]! };
}
type Caller = ReturnType<typeof caller>;

/**
 * The caller's own proposal. One whose consent is no longer among the app's live consents (revoked, expired or its key
 * removed) is withdrawn, unless it was already claimed or closed: then its state is the answer, never a withdrawal.
 */
function mine({ actor, consents }: Caller, id: string) {
  const loaded = loadProposal(id);
  if (!loaded || loaded.record.actor !== actor) throw new ORPCError("NOT_FOUND", { message: "No such proposal from this app.", data: { kind: "refused", code: "not_found" } });
  if (!consents.includes(loaded.record.consent)
    && close(id, { state: "withdrawn", reason: "the consent it was proposed under ended", at: new Date().toISOString() }))
    throw refused("withdrawn", "This proposal was made under a consent that ended. Nothing was sent; propose again.");
  return loaded;
}
const view = ({ record, sha256 }: { record: ProposalRecord; sha256: string }) => proposalView(record, sha256);

/** Why the proposal's bindings no longer hold now, or null. */
function bindingChange(record: ProposalRecord, live: { agentId: string; policyRevision: number | null; policyDigest: string | null; strategyDigest: string }) {
  if (live.agentId !== record.agentId) return "the agent changed";
  if (live.policyRevision !== record.policyRevision || live.policyDigest !== record.policyDigest)
    return `the policy changed (revision ${record.policyRevision} → ${live.policyRevision})`;
  if (live.strategyDigest !== record.strategyDigest) return "the owner's strategy changed";
  return null;
}
const invalidate = (id: string, reason: string) => {
  close(id, { state: "invalidated", reason, at: new Date().toISOString() });
  return refused("invalidated", `This proposal no longer holds: ${reason}. Nothing was sent; propose again.`);
};
async function liveBindings() {
  const view = await api.getPolicy(agentId());
  return { view, live: { agentId: agentId(), policyRevision: view.revision, policyDigest: view.policy ? mandateDigest(view.policy) : null,
    strategyDigest: strategyDigest(loadStrategy()) } };
}

/** The legs a rebalance toward the owner's strategy picks now: each worth its cost and unwarned, held to its floor. */
async function strategyLegs(): Promise<ChosenSwap[]> {
  const strategy = loadStrategy();
  const { book } = await observe();
  const { legs } = planLegs(book, strategy);
  const quotes = [];
  for (const leg of legs) quotes.push(await quoteLeg(leg));
  return planSteps(legs, quotes, strategy.maxCostBps).actions.flatMap(action =>
    action.type === "swap" ? [{ from: action.from, to: action.to, amount: action.amount, minAmountOut: action.minAmountOut }] : []);
}

/** Stores a proposal once per `requestId`; asked again with the same request, it answers the stored one. Sends nothing. */
export async function createProposal(context: CallContext, input: unknown, now = new Date()) {
  const who = caller(context);
  const { requestId, legs, expiresAt, note } = proposalCreateInput.parse(input);
  const request = { legs, expiresAt, note: note ?? null };
  const id = proposalIdOf(who.actor, requestId);
  const answer = () => {
    const stored = loadProposal(id)!;
    if (JSON.stringify(stored.record.request) !== JSON.stringify(request))
      throw new ORPCError("CONFLICT", { message: "This requestId was already used for another proposal. Nothing was stored.", data: { kind: "refused", code: "request_conflict" } });
    return view(mine(who, id));
  };
  if (loadProposal(id)) return answer();
  const until = Date.parse(expiresAt);
  if (until <= now.getTime() + 60_000) throw refused("expiry_invalid", "A proposal must stay valid for more than a minute.");
  if (until > now.getTime() + MAX_PROPOSAL_MS) throw refused("expiry_invalid", "A proposal is valid for at most 7 days.");
  const open = proposalIds().filter(other => { const p = loadProposal(other); return p && ["proposed", "approved"].includes(proposalState(p.record).state); });
  if (open.length >= MAX_OPEN_PROPOSALS) throw refused("too_many_proposals", `This agent already has ${MAX_OPEN_PROPOSALS} open proposals. Withdraw or wait for some.`);
  let quoted: Awaited<ReturnType<typeof quoteChosen>>;
  try {
    const chosen = legs === "strategy" ? await strategyLegs() : legs;
    if (!chosen.length) throw refused("nothing_to_propose", "The strategy picks no leg worth its cost now. Nothing was stored.");
    quoted = await quoteChosen(chosen);
  } catch (error) { if (error instanceof PublicError) throw refused("not_proposable", error.message); throw error; }
  const { snapshot, actions, usdIn } = quoted;
  const record: ProposalRecord = { version: 1, id, requestId, actor: who.actor, consent: who.consent, deployment: who.deployment, organization: who.organization,
    agentId: snapshot.agentId, source: legs === "strategy" ? "rebalance" : "external", request,
    legs: actions.map(({ from, to, amount, minAmountOut }) => ({ from, to, amount, minAmountOut })),
    quoted: actions.map(({ amountOut, costBps }, i) => ({ amountOut, costBps, usdIn: usdIn[i]! })),
    policyRevision: snapshot.policyRevision, policyDigest: snapshot.policyDigest, strategyDigest: snapshot.strategyDigest,
    createdAt: now.toISOString(), expiresAt: new Date(until).toISOString(), note: note ?? null };
  // Asked twice at once, one is stored and the other answers it.
  saveProposal(record);
  return answer();
}

export function getProposal(context: CallContext, input: unknown) {
  return view(mine(caller(context), proposalRef.parse(input).id));
}

/** This app's proposals, under any of its consents, newest first. Reading withdraws nothing. */
export function listProposals(context: CallContext) {
  const who = caller(context);
  const proposals = proposalIds().flatMap(id => { const p = loadProposal(id); return p && p.record.actor === who.actor ? [view(p)] : []; });
  return { proposals: proposals.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
}

/** Whether the owner's NEP-413 signature covers exactly this text for this host. The gateway checked the key is the owner's. */
function signs(signed: z.infer<typeof proposalSignature>, host: string, text: string) {
  if (signed.message !== text) return false;
  const nonce = Buffer.from(signed.nonce, "base64");
  if (nonce.length !== 32) return false;
  try { return verifyEd25519(signed.publicKey, nep413Hash(signed.message, nonce, host), signatureBytes(signed.signature)); } catch { return false; }
}

/** Records the owner's approval of the exact terms. Sends nothing: the app then asks for execution. */
export async function approveProposal(context: CallContext, input: unknown, now = new Date()) {
  const who = caller(context), { host } = who;
  const { id, signed } = proposalSigned.parse(input);
  const loaded = mine(who, id);
  const { record, sha256 } = loaded;
  const existing = readApproval(id);
  if (existing) {
    if (existing.signature === signed.signature) return view(loaded);
    throw refused("already_approved", "The owner already approved this proposal.");
  }
  const { state } = proposalState(record, now.getTime());
  if (state === "expired") { close(id, { state: "expired", reason: "its validity ended", at: now.toISOString() }); throw refused("expired", "This proposal expired. Nothing was sent."); }
  if (state !== "proposed") throw refused("not_open", `This proposal is ${state}; it can't be approved.`);
  if (!signs(signed, host, textOf(record, sha256, "approve")))
    throw refused("signature_invalid", "The signature isn't the owner's over this proposal's approval text for this host.");
  const { view: policy, live } = await liveBindings();
  const changed = bindingChange(record, live);
  if (changed) throw invalidate(id, changed);
  const unenforced = notInForce(policy);
  if (unenforced) throw refused("policy_not_in_force", `The policy is not in force: ${unenforced}. The approval wasn't recorded.`);
  saveApproval(id, { ...signed, host, at: now.toISOString() });
  // A rejection or withdrawal that landed meanwhile stands: this approval releases nothing.
  if (readFinal(id)) throw refused("not_open", "This proposal was closed while it was being approved.");
  return view(loadProposal(id)!);
}

/** The owner's signed rejection: closes the proposal unless it was already claimed or closed. */
export function rejectProposal(context: CallContext, input: unknown, now = new Date()) {
  const who = caller(context), { host } = who;
  const { id, signed } = proposalSigned.parse(input);
  const loaded = mine(who, id);
  if (!signs(signed, host, textOf(loaded.record, loaded.sha256, "reject")))
    throw refused("signature_invalid", "The signature isn't the owner's over this proposal's rejection text for this host.");
  if (!close(id, { state: "rejected", reason: "the owner rejected it", at: now.toISOString(), signed: { ...signed, host } }))
    throw refused("not_open", `This proposal is ${proposalState(loaded.record).state}; it can't be rejected.`);
  return view(loaded);
}

/** The proposing app withdraws it, unless it was already claimed or closed. */
export function withdrawProposal(context: CallContext, input: unknown, now = new Date()) {
  const { id } = proposalRef.parse(input);
  const loaded = mine(caller(context), id);
  if (!close(id, { state: "withdrawn", reason: "the app withdrew it", at: now.toISOString() }))
    throw refused("not_open", `This proposal is ${proposalState(loaded.record).state}; it can't be withdrawn.`);
  return view(loaded);
}

/**
 * One execution attempt of an approved proposal. Builds a plan from fresh quotes (each floor at least the signed one),
 * then runs it; under the money lock, after the plan's own checks, the proposal is re-checked and claimed, then the plan.
 * Refused before the claim: nothing was claimed or sent, and the proposal stays approved. Claimed: never again; the
 * answer is what the journal proves. Asked again once claimed or closed, it answers the state and sends nothing.
 */
export async function executeProposal(context: CallContext, input: unknown, now = () => new Date()) {
  const { id } = proposalRef.parse(input);
  const loaded = mine(caller(context), id);
  const { record, sha256 } = loaded;
  const { state } = proposalState(record, now().getTime());
  if (state === "proposed") throw refused("not_approved", "The owner hasn't approved this proposal. Nothing was sent.");
  if (state === "expired") { close(id, { state: "expired", reason: "its validity ended", at: now().toISOString() }); return view(loaded); }
  if (state !== "approved") return view(loaded);
  const approval = readApproval(id)!;

  const { live } = await liveBindings();
  const changed = bindingChange(record, live);
  if (changed) { invalidate(id, changed); return view(loaded); }
  let plan: Plan;
  try {
    const { snapshot, actions, now: at } = await quoteChosen(record.legs);
    plan = savePlan(snapshot, "proposal", `Treasury proposal ${id}`, actions, at, id);
  } catch (error) { if (error instanceof PublicError) throw refused("not_executable", `Not executed now: ${error.message}. Nothing was sent; the proposal stays approved.`); throw error; }

  /** The proposal's own checks, under the lock after the plan's, then its claim: only an approved, unexpired, unchanged proposal. */
  const beforeClaim = async (planned: Plan, observed: Observed) => {
    const fresh = loadProposal(id);
    if (!fresh || fresh.sha256 !== sha256) return ["the proposal's record changed"];
    const current = proposalState(fresh.record, now().getTime()).state;
    if (current !== "approved") return [`the proposal is ${current}`];
    const signedApproval = readApproval(id);
    if (!signedApproval || signedApproval.message !== textOf(fresh.record, sha256, "approve") || signedApproval.signature !== approval.signature)
      return ["the owner's approval doesn't match the proposal"];
    const changedNow = bindingChange(fresh.record, observed.snapshot);
    if (changedNow) return [changedNow];
    const unenforced = notInForce(observed.view);
    if (unenforced) return [`the policy is not in force: ${unenforced}`];
    const grant = liveGrant(await api.listGrants(agentId()), process.env.AGENT_GRANT_TOKEN);
    if (!grant || !(grant.label === "treasury" || grant.label.startsWith("treasury:"))) return ["no live treasury grant is held for this agent"];
    // Checked again as each swap is sent; checked here too, so a floor refusal leaves the proposal approved, not claimed.
    const cashFloor = loadStrategy().cashFloor;
    if (cashFloor && planBreaksCashFloor(cashFloor, planned.actions, observed.book, heldOutgoing()))
      return ["its swaps would take the strategy's cash under its floor"];
    // A stop begun during the reads above claims nothing: the proposal stays approved for after the restart.
    assertNotStopping();
    if (!claim(id, planned.id)) return ["the proposal was claimed or closed meanwhile"];
    return [];
  };
  const events: PlanEvent[] = [];
  running.add(id);
  try { for await (const event of executePlan(plan.id, now, { proposal: id, beforeClaim })) events.push(event); }
  catch (error) {
    // A send proven not made comes after the claim and is journaled: the proposal's view below reads it with whatever
    // was sent before it, where refusing the whole call would say nothing took effect.
    if (sendRefusal(error) === undefined) throw error;
  }
  finally { running.delete(id); }
  const final = readFinal(id);
  if (final?.state !== "claimed") {
    const problems = events.flatMap(event => event.type === "rejected" ? event.problems : []);
    throw refused("not_executable", `Not executed now: ${problems.join("; ")}. Nothing was sent; ${final
      ? `the proposal is ${final.state}` : "the proposal stays approved"}.`);
  }
  return view(loadProposal(id)!);
}
