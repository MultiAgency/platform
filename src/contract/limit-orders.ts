import { z } from "zod";
import { payoutRequestId } from "./inputs.js";
import { proposalSignature } from "./treasury-proposals.js";

/**
 * An app's resting Treasury order. These schemas and the owner's exact NEP-413 text are shared by
 * the platform and SDK consumers. An order is proposed and signed before its one placement attempt;
 * the provider's later fills and payouts are observations, never a reason to submit it again.
 */
// Asset identifiers become part of the owner's signed text; control characters could disguise a line.
const asset = z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/);
const positiveAtomic = z.string().regex(/^[0-9]{1,65}$/).refine(value => /[1-9]/.test(value), "Amount must be positive");
const positiveDecimal = z.string().max(40).regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/)
  .refine(value => /[1-9]/.test(value), "Price must be positive");
const deadline = z.iso.datetime().refine(value => Date.parse(value) > Date.now(), "Deadline must be in the future");
const terms = {
  base_asset: asset,
  quote_asset: asset,
  side: z.enum(["buy", "sell"]),
  quantity: positiveAtomic,
  price: positiveDecimal,
  deadline,
  confidential: z.literal(true),
};
const distinctAssets = (order: { base_asset: string; quote_asset: string }) => order.base_asset !== order.quote_asset;

/** Exact provider order terms. The service limits the deadline to seven days and checks a dry preview. */
export const limitOrderQuoteInput = z.strictObject(terms).refine(distinctAssets, "Order assets must differ");
/** Same terms, with the app's retry key and the validity of the owner's approval. */
export const limitOrderCreateInput = z.strictObject({
  ...terms,
  requestId: payoutRequestId,
  expiresAt: z.iso.datetime(),
  note: z.string().max(280).optional(),
}).refine(distinctAssets, "Order assets must differ");
export const limitOrderId = z.string().regex(/^[a-f0-9]{32}$/);
export const limitOrderRef = z.strictObject({ id: limitOrderId });
export const limitOrderSigned = z.strictObject({ id: limitOrderId, signed: proposalSignature });

const shownOrder = z.looseObject({
  base_asset: z.string(), quote_asset: z.string(), side: z.enum(["buy", "sell"]),
  quantity: z.string(), price: z.string(), deadline: z.string(), confidential: z.boolean(),
});

/** Dry provider preview and gross atomic spend; the quote does not reserve funds or place an order. */
export const limitOrderQuoteOutput = z.looseObject({
  order: shownOrder,
  spendAsset: z.string(), spendAmount: z.string(), outputAsset: z.string(),
  warnings: z.array(z.string()), quote: z.unknown(), ownerApproval: z.unknown(), fee: z.unknown(),
  policyRevision: z.number().nullable(), policyDigest: z.string().nullable(), strategyDigest: z.string(),
});

export const LimitOrderState = z.enum(["proposed", "approved", "placing", "resting", "partially_filled",
  "cancel_requested", "completed", "payout_failed", "unknown", "stopped", "rejected", "withdrawn", "expired", "invalidated"]);
export type LimitOrderState = z.infer<typeof LimitOrderState>;

/** Signed terms, local journal state, and the most recent provider observation. */
export const limitOrderView = z.looseObject({
  id: limitOrderId, requestId: z.string(), agentId: z.string(), deployment: z.string(), organization: z.string(),
  order: shownOrder,
  spendAsset: z.string(), spendAmount: z.string(), outputAsset: z.string(),
  policyRevision: z.number().nullable(), policyDigest: z.string().nullable(), strategyDigest: z.string(),
  createdAt: z.string(), expiresAt: z.string(), note: z.string().nullable(), sha256: z.string(),
  state: LimitOrderState, reason: z.string().nullable(), approvedAt: z.string().nullable(),
  /** Receipt digests let a DAO's vote relay reconcile a lost HTTP reply without submitting its signature again. */
  approvalSignatureHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  rejectionSignatureHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  correlationId: z.string().nullable(), orderId: z.string().nullable(),
  fillStatus: z.string().nullable(), payoutStatus: z.string().nullable(), isPayoutStatusFinal: z.boolean().nullable(),
  partialFills: z.array(z.unknown()).nullable(), payouts: z.record(z.string(), z.unknown()).nullable(),
  cancelRequestedAt: z.string().nullable(),
  operation: z.looseObject({ idempotencyKey: z.string(), status: z.string().nullable(), refused: z.string().nullable(),
    cancelFinal: z.boolean() }).nullable(),
});
export type LimitOrderView = z.infer<typeof limitOrderView>;
export const limitOrderListOutput = z.looseObject({ orders: z.array(limitOrderView) });

type SignedOrderTerms = Pick<LimitOrderView, "id" | "agentId" | "deployment" | "organization" | "spendAsset" |
  "spendAmount" | "outputAsset" | "policyRevision" | "policyDigest" | "strategyDigest" | "expiresAt" | "sha256"> & {
    order: { base_asset: string; quote_asset: string; side: "buy" | "sell"; quantity: string;
      price: string; deadline: string; confidential: boolean };
  };

/** Exact text accepted by the platform for one owner's approval or rejection of these terms. */
export function limitOrderText(order: SignedOrderTerms, verdict: "approve" | "reject") {
  return [
    `${verdict === "approve" ? "Approve" : "Reject"} Treasury limit order ${order.id}`,
    `Agent ${order.agentId}`,
    `Proposed by ${order.deployment} for ${order.organization}`,
    `Order: ${order.order.side} ${order.order.quantity} atomic units of ${order.order.base_asset} at price ${order.order.price} ${order.order.quote_asset} per base unit`,
    `Deadline ${order.order.deadline}; confidential ${order.order.confidential}`,
    `Gross spend ${order.spendAmount} atomic units of ${order.spendAsset}; output asset ${order.outputAsset}`,
    `Under policy revision ${order.policyRevision ?? "none"} (${order.policyDigest ?? "none"}), strategy ${order.strategyDigest}`,
    `Valid until ${order.expiresAt}. Order sha256 ${order.sha256}.`,
  ].join("\n");
}
