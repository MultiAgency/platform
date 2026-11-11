import { ORPCError } from "@orpc/server";
import { createHash } from "node:crypto";
import { api } from "../api.js";
import { dispatch, LocalRefusal } from "../agent.js";
import { notInForce } from "../authorize.js";
import { limitOrderCreateInput, limitOrderQuoteInput, limitOrderRef, limitOrderSigned, limitOrderText } from "../contract/limit-orders.js";
import { agentId, executes } from "../env.js";
import { acquireMoneyLock, withMoneyLock } from "../lock.js";
import { canonicalRecord, mandateDigest } from "../mandate.js";
import { signsText } from "../nep413.js";
import { blocksDispatch, readOps, record } from "../ops.js";
import { outputAssetRefusal } from "../policy.js";
import { PublicError } from "../public-error.js";
import type { CallContext } from "../rpc/base.js";
import { loadStrategy } from "../strategy.js";
import { strategyDigest } from "../strategy-digest.js";
import { assertLimitOrderPreviewSpend, calculateLimitOrderSpend, type LimitOrderTerms } from "./terms.js";
import { latestOrderObservation, orderFinality, refreshTrackedOrder } from "./observe.js";
import { closeOrderProposal, loadOrderProposal, orderProposalIdOf, orderProposalIds,
  readOrderApproval, readOrderCancellation, readOrderFinal, readOrderPlacement, saveOrderApproval, saveOrderProposal,
  type OrderProposalRecord } from "./store.js";

const ACTOR = /^app:([a-z0-9-]{1,32}):([A-Za-z0-9_-]{1,128})$/;
const MAX_ORDER_MS = 7 * 86_400_000;
const MAX_OPEN_ORDERS = 32;
const refused = (code: string, message: string) => new ORPCError("BAD_REQUEST", { message, data: { kind: "refused", code } });

/** Only the app's current, dedicated consent can name these signed Treasury orders. */
function caller({ actor, consent, host, consents }: CallContext) {
  const match = actor?.match(ACTOR);
  if (!match || !consent || !/^[a-f0-9]{64}$/.test(consent) || !host || !consents?.includes(consent))
    throw new PublicError("Treasury limit orders are made through a consented app. Nothing was stored.");
  if (!executes()) throw new PublicError("This copy only approves: ask the agent's executor about limit orders.");
  return { actor: actor!, consent, host, consents: consents!, deployment: match[1]!, organization: match[2]! };
}
type Caller = ReturnType<typeof caller>;

function mine(who: Caller, id: string) {
  const loaded = loadOrderProposal(id);
  if (!loaded || loaded.record.actor !== who.actor)
    throw new ORPCError("NOT_FOUND", { message: "No such limit order from this app.", data: { kind: "refused", code: "not_found" } });
  if (Date.now() >= Date.parse(loaded.record.expiresAt) && !readOrderFinal(id))
    closeOrderProposal(id, { state: "expired", reason: "its validity ended", at: new Date().toISOString() });
  if (!who.consents.includes(loaded.record.consent))
    closeOrderProposal(id, { state: "withdrawn", reason: "the consent it was proposed under ended", at: new Date().toISOString() });
  const changed = bindings(loaded.record);
  if (changed && !readOrderFinal(id))
    closeOrderProposal(id, { state: "invalidated", reason: changed, at: new Date().toISOString() });
  return loaded;
}

function bindings(record: OrderProposalRecord) {
  if (record.agentId !== agentId()) return "the agent changed";
  if (record.strategyDigest !== strategyDigest(loadStrategy())) return "the Treasury strategy changed";
  return null;
}

async function liveBindingProblem(record: OrderProposalRecord) {
  const held = bindings(record);
  if (held) return held;
  const view = await api.getPolicy(agentId());
  if (view.revision !== record.policyRevision || (view.policy ? mandateDigest(view.policy) : null) !== record.policyDigest)
    return "the owner-signed policy changed";
  return notInForce(view);
}

function state(record: OrderProposalRecord) {
  const final = readOrderFinal(record.id);
  if (final && final.state !== "claimed") return { state: final.state, reason: final.reason };
  if (final?.state === "claimed") {
    const op = readOps().find(row => row.idempotencyKey === final.operationKey);
    if (!op || blocksDispatch(op)) return { state: "unknown" as const, reason: "placement outcome is unproven" };
    if (op.refused || op.status === "FAILED" || op.status === "REFUNDED") return { state: "stopped" as const, reason: op.refused ?? op.status ?? null };
    const placed = readOrderPlacement(record.id);
    if (!placed) return op.status === "SUCCESS"
      ? { state: "unknown" as const, reason: "the funded order's provider identity is missing; preserve state for review" }
      : { state: "placing" as const, reason: null };
    const observed = latestOrderObservation(record.id);
    if (!observed) return { state: "unknown" as const, reason: "the funded order has no live fill read yet" };
    const finality = orderFinality(observed);
    if (finality === "complete") return { state: "completed" as const, reason: null };
    if (finality === "failed") return { state: "payout_failed" as const, reason: "a final payout failed; review required" };
    if (readOrderCancellation(record.id)) return { state: "cancel_requested" as const, reason: null };
    if (observed.fill_status === "partially_filled") return { state: "partially_filled" as const, reason: null };
    return { state: finality === "unknown" ? "unknown" as const : "resting" as const, reason: finality === "unknown" ? "order finality is unknown" : null };
  }
  if (Date.now() >= Date.parse(record.expiresAt)) return { state: "expired" as const, reason: "its validity ended" };
  return { state: readOrderApproval(record.id) ? "approved" as const : "proposed" as const, reason: null };
}

function view(loaded: { record: OrderProposalRecord; sha256: string }) {
  const { record, sha256 } = loaded;
  const placed = readOrderPlacement(record.id);
  const latest = placed ? latestOrderObservation(record.id) : null;
  const cancellation = readOrderCancellation(record.id);
  const final = readOrderFinal(record.id);
  const approval = readOrderApproval(record.id);
  const signatureHash = (signature: string) => createHash("sha256").update(signature).digest("hex");
  const operation = final?.state === "claimed" ? readOps().find(row => row.idempotencyKey === final.operationKey) : null;
  return {
    id: record.id, requestId: record.requestId, agentId: record.agentId, deployment: record.deployment,
    organization: record.organization, order: record.order, spendAsset: record.spendAsset,
    spendAmount: record.spendAmount, outputAsset: record.outputAsset, policyRevision: record.policyRevision,
    policyDigest: record.policyDigest, strategyDigest: record.strategyDigest, createdAt: record.createdAt,
    expiresAt: record.expiresAt, note: record.note, sha256, approvedAt: approval?.at ?? null,
    approvalSignatureHash: approval ? signatureHash(approval.signature) : null,
    rejectionSignatureHash: final?.state === "rejected" && final.signed ? signatureHash(final.signed.signature) : null,
    correlationId: placed?.correlationId ?? operation?.correlationId ?? null, orderId: placed?.orderId ?? null,
    fillStatus: latest?.fill_status ?? null, payoutStatus: latest?.payout_status ?? null,
    isPayoutStatusFinal: latest?.is_payout_status_final ?? null, partialFills: latest?.partial_fills ?? null,
    payouts: latest?.payouts ?? null, cancelRequestedAt: cancellation?.at ?? null,
    operation: operation ? { idempotencyKey: operation.idempotencyKey, status: operation.status ?? null,
      refused: operation.refused ?? null, cancelFinal: operation.cancelFinal ?? false } : null,
    ...state(record),
  };
}

async function previewOrder(order: LimitOrderTerms & { deadline: string; confidential: true }, now = Date.now()) {
  const until = Date.parse(order.deadline);
  if (!Number.isFinite(until) || until <= now + 60_000 || until > now + MAX_ORDER_MS)
    throw refused("deadline_invalid", "A limit order needs a deadline more than a minute and at most 7 days ahead.");
  const [tokens, preview, policy] = await Promise.all([
    api.getTokens(), api.placeLimitOrder(agentId(), { ...order, dry: true }), api.getPolicy(agentId()),
  ]);
  const base = tokens.find(t => t.asset_id === order.base_asset);
  const quote = tokens.find(t => t.asset_id === order.quote_asset);
  if (!base || !quote) throw refused("token_unread", "Both order tokens need provider metadata.");
  let spend: ReturnType<typeof calculateLimitOrderSpend>;
  try {
    spend = calculateLimitOrderSpend(order, { base: base.decimals, quote: quote.decimals });
    assertLimitOrderPreviewSpend(spend, preview.quote);
  } catch { throw refused("preview_mismatch", "The provider's dry preview does not match the exact atomic spend."); }
  if (preview.dry !== true || preview.type !== "limit_order" || !Array.isArray(preview.warnings))
    throw refused("preview_invalid", "The provider did not return a valid dry limit-order preview.");
  return { order, spend, preview, policy };
}

/** Preview only; this uses no grant, keyless live request or state mutation. */
export async function quoteLimitOrder(context: CallContext, input: unknown) {
  caller(context);
  const { order, spend, preview, policy } = await previewOrder(limitOrderQuoteInput.parse(input));
  return { order, ...spend, warnings: preview.warnings.map(w => w.code), quote: preview.quote,
    ownerApproval: preview.owner_approval, fee: preview.fee, policyRevision: policy.revision,
    policyDigest: policy.policy ? mandateDigest(policy.policy) : null, strategyDigest: strategyDigest(loadStrategy()) };
}

/** Save exact terms once per app request; a proposal is not a placement or fill. */
export async function createLimitOrder(context: CallContext, input: unknown, now = new Date()) {
  const who = caller(context);
  const parsed = limitOrderCreateInput.parse(input);
  const { requestId, expiresAt, note, ...order } = parsed;
  const id = orderProposalIdOf(who.actor, requestId);
  const requested = { order, expiresAt, note: note ?? null };
  const answerExisting = () => {
    const stored = mine(who, id);
    const original = { order: stored.record.order, expiresAt: stored.record.expiresAt, note: stored.record.note };
    if (canonicalRecord(original) !== canonicalRecord(requested)) throw refused("request_conflict", "This requestId already names different order terms.");
    return view(stored);
  };
  if (loadOrderProposal(id)) return answerExisting();
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now.getTime() + 60_000 || expiry > now.getTime() + MAX_ORDER_MS || expiry > Date.parse(order.deadline))
    throw refused("expiry_invalid", "The owner approval must expire before the order deadline and within 7 days.");
  const full = () => orderProposalIds().filter(other => {
    const loaded = loadOrderProposal(other);
    return loaded && ["proposed", "approved"].includes(state(loaded.record).state);
  }).length >= MAX_OPEN_ORDERS;
  if (full()) throw refused("too_many_orders", "This agent already has 32 open limit-order proposals.");
  const { spend, preview, policy } = await previewOrder(order, now.getTime());
  const unenforced = notInForce(policy);
  if (unenforced) throw refused("policy_not_in_force", `The policy is not in force: ${unenforced}.`);
  if (preview.warnings.length) throw refused("preview_warned", "The provider's dry preview does not clear this order.");
  const outputProblem = outputAssetRefusal({ method: "limit_order", request: order }, policy.policy!);
  if (outputProblem) throw refused("asset_out_not_allowed", outputProblem);
  if (loadStrategy().cashFloor) throw refused("cash_floor_order_unsupported", "Remove the Treasury cash floor before proposing a resting order.");
  const record: OrderProposalRecord = { version: 1, id, requestId, actor: who.actor, consent: who.consent,
    deployment: who.deployment, organization: who.organization, agentId: agentId(), order, ...spend,
    policyRevision: policy.revision, policyDigest: policy.policy ? mandateDigest(policy.policy) : null,
    strategyDigest: strategyDigest(loadStrategy()), createdAt: now.toISOString(), expiresAt,
    note: note ?? null };
  if (loadOrderProposal(id)) return answerExisting();
  if (full()) throw refused("too_many_orders", "This agent already has 32 open limit-order proposals.");
  saveOrderProposal(record);
  return answerExisting();
}

export function getLimitOrder(context: CallContext, input: unknown) {
  return view(mine(caller(context), limitOrderRef.parse(input).id));
}

export function listLimitOrders(context: CallContext) {
  const who = caller(context);
  return { orders: orderProposalIds().flatMap(id => {
    const loaded = loadOrderProposal(id);
    return loaded && loaded.record.actor === who.actor ? [view(mine(who, id))] : [];
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
}

/** The gateway checked the key belongs to the owner; the agent verifies these exact NEP-413 bytes. */
export async function approveLimitOrder(context: CallContext, input: unknown, now = new Date()) {
  const who = caller(context);
  const { id, signed } = limitOrderSigned.parse(input);
  const loaded = mine(who, id);
  const prior = readOrderApproval(id);
  if (prior) {
    if (prior.signature === signed.signature) return view(loaded);
    throw refused("already_approved", "The owner already approved this order.");
  }
  if (state(loaded.record).state !== "proposed") throw refused("not_open", "This order is no longer open for approval.");
  const text = limitOrderText({ ...loaded.record, sha256: loaded.sha256 }, "approve");
  if (!signsText(signed, who.host, text)) throw refused("signature_invalid", "The owner did not sign this order's exact terms.");
  const changed = await liveBindingProblem(loaded.record);
  if (changed) {
    closeOrderProposal(id, { state: "invalidated", reason: changed, at: now.toISOString() });
    throw refused("invalidated", `The order's binding changed: ${changed}.`);
  }
  if (!saveOrderApproval(id, { ...signed, host: who.host, at: now.toISOString() }) && readOrderApproval(id)?.signature !== signed.signature)
    throw refused("already_approved", "The owner already approved this order.");
  if (readOrderFinal(id)) throw refused("not_open", "This order closed while approval was being recorded.");
  return view(loadOrderProposal(id)!);
}

export function rejectLimitOrder(context: CallContext, input: unknown, now = new Date()) {
  const who = caller(context);
  const { id, signed } = limitOrderSigned.parse(input);
  const loaded = mine(who, id);
  const prior = readOrderFinal(id);
  if (prior?.state === "rejected" && prior.signed?.signature === signed.signature) return view(loaded);
  const text = limitOrderText({ ...loaded.record, sha256: loaded.sha256 }, "reject");
  if (!signsText(signed, who.host, text)) throw refused("signature_invalid", "The owner did not sign this order's rejection text.");
  if (!closeOrderProposal(id, { state: "rejected", reason: "the owner rejected it", at: now.toISOString(), signed: { ...signed, host: who.host } }))
    throw refused("not_open", "This order was already claimed or closed.");
  return view(loaded);
}

/** One send attempt only. A claimed proposal is read on retries, including after a lost answer. */
export async function placeLimitOrder(context: CallContext, input: unknown) {
  const who = caller(context);
  const { id } = limitOrderRef.parse(input);
  const loaded = mine(who, id);
  if (state(loaded.record).state === "proposed") throw refused("not_approved", "The owner has not signed this order.");
  if (state(loaded.record).state !== "approved") return view(loaded);
  const approval = readOrderApproval(id);
  if (!approval || approval.message !== limitOrderText({ ...loaded.record, sha256: loaded.sha256 }, "approve"))
    throw refused("signature_invalid", "The stored owner approval does not match this order.");
  try {
    await withMoneyLock(async lock => {
      await dispatch(lock, "limit-order", { method: "limit_order", request: loaded.record.order }, undefined, undefined,
        undefined, undefined, undefined, undefined,
        { proposalId: id });
      if (readOrderPlacement(id)) try { await refreshTrackedOrder(id); } catch { /* The funded order remains tracked for status-only recovery. */ }
    });
  } catch (error) {
    if (error instanceof LocalRefusal && ["order_policy_changed", "order_strategy_changed"].includes(error.code))
      closeOrderProposal(id, { state: "invalidated", reason: error.detail, at: new Date().toISOString() });
    throw error;
  }
  return view(loadOrderProposal(id)!);
}

/** Cancel at most once, even if the provider reply is lost; fills and refunds are read afterward. */
export async function cancelLimitOrder(context: CallContext, input: unknown) {
  const who = caller(context);
  const { id } = limitOrderRef.parse(input);
  const loaded = mine(who, id);
  if (!readOrderPlacement(id)) throw refused("not_placed", "This proposal has no funded order to cancel.");
  if (readOrderCancellation(id)) return refreshLimitOrder(context, input);
  await withMoneyLock(lock => dispatch(lock, "limit-order-cancel", { method: "limit_order_cancel", request: { proposalId: id } }));
  return view(loaded);
}

/** Status-only recovery; a new request never repeats placement or cancellation. */
export async function refreshLimitOrder(context: CallContext, input: unknown) {
  const who = caller(context);
  const { id } = limitOrderRef.parse(input);
  const loaded = mine(who, id);
  if (!readOrderPlacement(id)) return view(loaded);
  const lock = await acquireMoneyLock({ reconcile: true });
  try {
    const observed = await refreshTrackedOrder(id);
    const cancelOp = readOps().find(op => op.idempotencyKey === `limit-order-cancel:${id}`);
    if (cancelOp?.submissionState === "SUBMISSION_ATTEMPTED" && !cancelOp.cancelFinal) {
      const placed = readOrderPlacement(id), claimed = readOrderCancellation(id);
      if (!placed || !claimed || placed.orderId !== claimed.orderId || cancelOp.request.orderId !== placed.orderId)
        throw new Error("Cancellation claim or placement identity is missing; preserve state for review");
      if (orderFinality(observed) === "complete")
        record({ idempotencyKey: cancelOp.idempotencyKey, cancelFinal: true });
    }
  } finally { await lock.release(); }
  return view(loaded);
}
