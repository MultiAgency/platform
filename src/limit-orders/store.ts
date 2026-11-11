import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { limitOrderText } from "../contract/limit-orders.js";
import { agentId } from "../env.js";
import { canonicalRecord } from "../mandate.js";
import type { Op } from "../ops.js";
import { readRecordLines } from "../record-lines.js";
import { appendSynced, createOnce, mkdirSynced } from "../synced.js";

/**
 * One agent's limit-order proposals live below `.proposals/limit-orders/<agent id>/`, separate from
 * the 0.5.6 Treasury proposal reader's `.proposals/<agent id>/*.json` and legacy `.proposals/*.json`.
 * A proposal, approval, final decision, placement and cancellation claim are whole write-once files.
 * Provider observations are a synced append-only history; a damaged line makes that history unavailable.
 */
const ROOT = join(".proposals", "limit-orders");
const ID = /^[a-f0-9]{32}$/;
const PROPOSAL = /^[a-f0-9]{32}\.json$/;
const nonempty = z.string().min(1);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const amount = z.string().regex(/^[1-9]\d*$/);
const timestamp = z.iso.datetime();

export const OrderProposalRecord = z.strictObject({
  version: z.literal(1),
  id: z.string().regex(ID),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  actor: nonempty,
  consent: z.string().regex(/^[a-f0-9]{64}$/),
  deployment: nonempty,
  organization: nonempty,
  agentId: nonempty,
  order: z.strictObject({
    base_asset: nonempty,
    quote_asset: nonempty,
    side: z.enum(["buy", "sell"]),
    quantity: amount.max(65),
    price: z.string().max(40).regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/),
    deadline: timestamp,
    confidential: z.boolean(),
  }),
  spendAsset: nonempty,
  spendAmount: amount,
  outputAsset: nonempty,
  policyRevision: z.number().int().nonnegative().nullable(),
  policyDigest: digest.nullable(),
  strategyDigest: digest,
  createdAt: timestamp,
  expiresAt: timestamp,
  note: z.string().max(280).nullable(),
});
export type OrderProposalRecord = z.infer<typeof OrderProposalRecord>;

const Stored = z.strictObject({ proposal: OrderProposalRecord, sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export const OrderApproval = z.strictObject({
  message: nonempty, nonce: nonempty, publicKey: nonempty, signature: nonempty, host: nonempty, at: timestamp,
});
export type OrderApproval = z.infer<typeof OrderApproval>;
export const OrderClosed = z.strictObject({
  state: z.enum(["rejected", "withdrawn", "expired", "invalidated"]), reason: nonempty, at: timestamp,
  signed: z.strictObject({ message: nonempty, nonce: nonempty, publicKey: nonempty, signature: nonempty, host: nonempty }).optional(),
});
export type OrderClosed = z.infer<typeof OrderClosed>;
const OrderFinal = z.union([OrderClosed, z.strictObject({ state: z.literal("claimed"), operationKey: nonempty, at: timestamp })]);
export type OrderFinal = z.infer<typeof OrderFinal>;
export const OrderPlacement = z.strictObject({ correlationId: nonempty, orderId: nonempty, at: timestamp });
export type OrderPlacement = z.infer<typeof OrderPlacement>;

/** The SDK's getLimitOrder view is open-ended; keep all keys while validating its lifecycle evidence. */
export const OrderProviderView = z.looseObject({
  order_id: nonempty,
  fill_status: z.string().optional(),
  payout_status: z.string().optional(),
  is_payout_status_final: z.boolean().optional(),
  partial_fills: z.array(z.unknown()).nullable().optional(),
  payouts: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type OrderProviderView = z.infer<typeof OrderProviderView>;
const OrderObservation = z.strictObject({ at: timestamp, view: OrderProviderView });
export type OrderObservation = z.infer<typeof OrderObservation>;
const OrderCancellation = z.strictObject({ orderId: nonempty, at: timestamp });
export type OrderCancellation = z.infer<typeof OrderCancellation>;

const currentAgent = () => {
  const id = agentId();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid agent id for limit-order state");
  return id;
};
const own = () => join(ROOT, currentAgent());
const validId = (id: string) => {
  if (!ID.test(id)) throw new Error("Invalid limit-order proposal id");
  return id;
};
const file = (id: string, suffix: string) => join(own(), `${validId(id)}${suffix}`);
const sha = (record: OrderProposalRecord) => createHash("sha256").update(canonicalRecord(record)).digest("hex");
const consistent = (record: OrderProposalRecord) => record.agentId === currentAgent()
  && record.id === orderProposalIdOf(record.actor, record.requestId)
  && record.actor === `app:${record.deployment}:${record.organization}`
  && record.order.base_asset !== record.order.quote_asset
  && !/^0+(?:\.0+)?$/.test(record.order.price)
  && record.spendAsset === (record.order.side === "sell" ? record.order.base_asset : record.order.quote_asset)
  && record.outputAsset === (record.order.side === "sell" ? record.order.quote_asset : record.order.base_asset)
  && (record.order.side !== "sell" || record.spendAmount === record.order.quantity)
  && (record.policyRevision === null) === (record.policyDigest === null)
  && Date.parse(record.createdAt) < Date.parse(record.expiresAt)
  && Date.parse(record.createdAt) < Date.parse(record.order.deadline);
const readJson = <T extends z.ZodType>(path: string, schema: T): z.output<T> | null => {
  if (!existsSync(path)) return null;
  try { return schema.parse(JSON.parse(readFileSync(path, "utf8"))); }
  catch { throw new Error(`Invalid limit-order state in ${path}; preserve it and investigate before retrying`); }
};
const ensureDirectories = () => {
  mkdirSynced(".proposals");
  mkdirSynced(ROOT);
  mkdirSynced(own());
};
const existingProposal = (id: string) => {
  if (!loadOrderProposal(id)) throw new Error(`Limit-order proposal ${id} is missing; preserve state and investigate`);
};
const readBound = <T extends z.ZodType>(id: string, suffix: string, schema: T): z.output<T> | null => {
  const value = readJson(file(id, suffix), schema);
  if (value) existingProposal(id);
  return value;
};

/** Stable request identity, separate from ordinary Treasury proposals. */
export const orderProposalIdOf = (actor: string, requestId: string) =>
  createHash("sha256").update(`limit-order\n${actor}\n${requestId}`).digest("hex").slice(0, 32);

/** The immutable proposal, with its reproducible hash; null only when no record exists. */
export function loadOrderProposal(id: string) {
  const stored = readJson(file(id, ".json"), Stored);
  if (!stored) return null;
  const record = stored.proposal;
  if (record.id !== id || !consistent(record) || stored.sha256 !== sha(record))
    throw new Error(`Limit-order proposal ${id} was changed or misplaced after saving`);
  return { record, sha256: stored.sha256 };
}

/** A write-once proposal; an existing id is left untouched for the caller to compare and answer. */
export function saveOrderProposal(value: OrderProposalRecord) {
  const record = OrderProposalRecord.parse(value);
  if (!consistent(record))
    throw new Error("Limit-order proposal terms are inconsistent");
  ensureDirectories();
  const saved = createOnce(file(record.id, ".json"), JSON.stringify({ proposal: record, sha256: sha(record) }, null, 2));
  if (!saved) loadOrderProposal(record.id); // an existing corrupt record cannot be silently treated as a duplicate
  return saved;
}

/** Only this agent's order proposals; never legacy Treasury proposals or another agent's. */
export function orderProposalIds() {
  const names = existsSync(own()) ? readdirSync(own()) : [];
  const ids = names.filter(name => PROPOSAL.test(name)).map(name => name.slice(0, 32));
  const present = new Set(ids);
  for (const name of names) {
    const artifact = name.match(/^([a-f0-9]{32})\.(?:approval|final|placed|cancel)\.json$|^([a-f0-9]{32})\.observations\.jsonl$/);
    if (artifact && !present.has(artifact[1] ?? artifact[2]!))
      throw new Error(`Orphan limit-order state ${name}; preserve it and investigate before retrying`);
  }
  for (const id of ids) loadOrderProposal(id);
  return ids;
}

export const readOrderApproval = (id: string) => readBound(id, ".approval.json", OrderApproval);
export function saveOrderApproval(id: string, value: OrderApproval) {
  existingProposal(id);
  if (readOrderFinal(id)) return false;
  ensureDirectories();
  const saved = createOnce(file(id, ".approval.json"), JSON.stringify(OrderApproval.parse(value)));
  if (!saved && canonicalRecord(readOrderApproval(id)) !== canonicalRecord(OrderApproval.parse(value)))
    throw new Error(`Limit-order proposal ${id} has conflicting owner approval evidence`);
  return saved;
}

export const readOrderFinal = (id: string) => readBound(id, ".final.json", OrderFinal);
/** Closing and claiming race for this one file, so neither can reverse the other. */
export function closeOrderProposal(id: string, value: OrderClosed) {
  existingProposal(id);
  if (readOrderFinal(id)) return false;
  const saved = createOnce(file(id, ".final.json"), JSON.stringify(OrderClosed.parse(value)));
  if (!saved) readOrderFinal(id);
  return saved;
}
/** Claimed immediately before dispatch; a later call must read evidence, never submit again. */
export function claimOrderProposal(id: string, operationKey: string) {
  existingProposal(id);
  if (readOrderFinal(id)) return false;
  if (!readOrderApproval(id)) throw new Error(`Limit-order proposal ${id} has no owner approval`);
  const saved = createOnce(file(id, ".final.json"), JSON.stringify(OrderFinal.parse({ state: "claimed", operationKey, at: new Date().toISOString() })));
  if (!saved) readOrderFinal(id);
  return saved;
}

export const readOrderPlacement = (id: string) => {
  const placed = readBound(id, ".placed.json", OrderPlacement);
  if (placed && readOrderFinal(id)?.state !== "claimed")
    throw new Error(`Limit-order proposal ${id} has placement evidence without a claim`);
  return placed;
};
/** Record both provider identities once. A changed answer is an error, never a new placement. */
export function saveOrderPlacement(id: string, value: OrderPlacement) {
  existingProposal(id);
  if (readOrderFinal(id)?.state !== "claimed") throw new Error(`Limit-order proposal ${id} was not claimed for placement`);
  const placement = OrderPlacement.parse(value);
  const path = file(id, ".placed.json");
  if (createOnce(path, JSON.stringify(placement))) return true;
  // Recovery reads the same provider identity later, at a different clock time. The first
  // observation time is retained; only a changed provider identity is a conflict.
  const prior = readOrderPlacement(id);
  if (prior?.correlationId !== placement.correlationId || prior?.orderId !== placement.orderId)
    throw new Error(`Limit-order proposal ${id} has conflicting placement evidence`);
  return false;
}

/** Append the whole provider view; do not collapse partial fills or payout evidence into a terminal boolean. */
export function appendOrderObservation(id: string, view: OrderProviderView, at = new Date().toISOString()) {
  existingProposal(id);
  const placement = readOrderPlacement(id);
  if (!placement) throw new Error(`Limit-order proposal ${id} has no placement identity`);
  const row = OrderObservation.parse({ at, view });
  if (row.view.order_id !== placement.orderId) throw new Error(`Provider observation names another limit order`);
  const previous = readOrderObservations(id).at(-1);
  if (previous && canonicalRecord(previous.view) === canonicalRecord(row.view)) return false;
  appendSynced(file(id, ".observations.jsonl"), row);
  return true;
}
/** A malformed or torn line makes the entire observation history unavailable. */
export function readOrderObservations(id: string): OrderObservation[] {
  const path = file(id, ".observations.jsonl");
  if (!existsSync(path)) return [];
  existingProposal(id);
  const placement = readOrderPlacement(id);
  if (!placement) throw new Error(`Limit-order proposal ${id} has observations without placement evidence`);
  const rows = readRecordLines(path, OrderObservation);
  if (rows.some(row => row.view.order_id !== placement.orderId))
    throw new Error(`Limit-order proposal ${id} has observations for another order`);
  return rows;
}

export const readOrderCancellation = (id: string) => {
  const claimed = readBound(id, ".cancel.json", OrderCancellation);
  if (claimed && readOrderPlacement(id)?.orderId !== claimed.orderId)
    throw new Error(`Limit-order proposal ${id} has a cancellation claim for another order`);
  return claimed;
};

/** A terminal funded placement still blocks new sends if its local order identity or signed claim was lost. */
export function assertSuccessfulOrderEvidence(ops: readonly Op[]) {
  for (const op of ops) {
    if (op.method !== "limit_order" || op.status !== "SUCCESS") continue;
    const id = op.idempotencyKey.match(/^limit-order:([a-f0-9]{32})$/)?.[1];
    if (!id) throw new Error(`Successful limit order ${op.idempotencyKey} has an invalid proposal identity; preserve state and investigate`);
    const proposal = loadOrderProposal(id);
    const approval = proposal && readOrderApproval(id);
    if (!proposal || !approval || approval.message !== limitOrderText({ ...proposal.record, sha256: proposal.sha256 }, "approve")
      || canonicalRecord(op.request) !== canonicalRecord(proposal.record.order))
      throw new Error(`Successful limit order ${id} lost its exact owner-approved proposal; preserve state and investigate`);
    const claim = readOrderFinal(id);
    if (claim?.state !== "claimed" || claim.operationKey !== op.idempotencyKey)
      throw new Error(`Successful limit order ${id} lost its one-way placement claim; preserve state and investigate`);
    const placed = readOrderPlacement(id);
    if (!placed || !op.correlationId || placed.correlationId !== op.correlationId)
      throw new Error(`Successful limit order ${id} lost its provider order identity; preserve state and investigate`);
  }
}
/** Claim cancellation before its first provider call. A crash or lost answer permits reads only, never replay. */
export function claimOrderCancellation(id: string, orderId: string) {
  existingProposal(id);
  const placement = readOrderPlacement(id);
  if (!placement || placement.orderId !== orderId) throw new Error(`Limit-order cancellation has no matching placement`);
  const existing = readOrderCancellation(id);
  if (existing) return false;
  const saved = createOnce(file(id, ".cancel.json"), JSON.stringify(OrderCancellation.parse({ orderId, at: new Date().toISOString() })));
  if (!saved) readOrderCancellation(id);
  return saved;
}
