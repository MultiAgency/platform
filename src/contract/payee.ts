import { z } from "zod";
import { agreementRecord, compensationView, requestRecord } from "../compensation-contract.js";

/** Payee HTTP responses under the instance base. The platform's handlers are tested against these schemas. */
export const invoiceStatus = z.enum(["needs_agreement", "refused", "busy", "prepared", "waiting", "paying", "paid", "failed", "unknown", "needs_review"]);
export const agreementStatus = z.enum(["requested", "proposed", "agreed", "filed", "declined"]);

export const errorBody = z.object({ error: z.string(), code: z.string().optional() });
export const session = z.object({ account: z.string().nullable(), agreed: z.boolean() });
export const compensationSession = z.object({ account: z.string().nullable() });
export const signInResult = z.object({ account: z.string(), agreed: z.boolean().optional() });
export const signOutResult = z.object({ account: z.null() });

export const invoice = z.object({ id: z.string(), amount: z.string().nullable(), note: z.string(), filedAt: z.string(), status: invoiceStatus, revisionConflict: z.boolean() });
export const agreement = z.object({ id: z.string(), origin: z.enum(["owner", "payee"]), amount: z.string(), note: z.string(), submission: z.string().optional(),
  terms: z.object({ maxAmount: z.string(), until: z.string() }).optional(), status: agreementStatus, at: z.string() });
export const invoicesView = z.object({ invoices: z.array(invoice), agreements: z.array(agreement), agreed: z.boolean() });
/** POST /api/invoices and /api/invoices/:id/continue. An account not yet agreed receives an agreement request instead. */
export const fileResult = z.union([
  z.object({ id: z.string(), status: invoiceStatus, revisionConflict: z.boolean().optional() }),
  z.object({ id: z.string(), status: z.union([agreementStatus, z.literal("busy")]) }),
]);

export const workOrderSummary = z.object({ id: z.uuid(), amount: z.string(), note: z.string(), until: z.string(), createdAt: z.string() });
export const workOrderList = z.object({ orders: z.array(workOrderSummary) });
export const publicWorkOrder = workOrderSummary.extend({ invoice: invoice.nullable(), ready: z.boolean(), unavailable: z.boolean() });
export const payeeWorkOrderRequest = z.object({ submission: z.uuid(), amount: z.string(), note: z.string().trim().min(1).max(200), until: z.iso.datetime() }).strict();
export const workOrderRequestResult = z.object({ id: z.uuid(), status: z.literal("requested") });

/** Member identities are redacted to "owner" before they reach the payee. */
export const payeeCompensationView = z.object({
  account: z.string(),
  agreements: compensationView.shape.agreements,
  requests: z.array(requestRecord),
  history: z.array(z.object({ sequence: z.number(), actor: z.string(), record: z.union([requestRecord, agreementRecord]) })),
  payments: z.array(z.object({ requestId: z.uuid(), id: z.string(), status: z.string() })),
});

export type InvoiceStatus = z.infer<typeof invoiceStatus>;
export type Invoice = z.infer<typeof invoice>;
export type Agreement = z.infer<typeof agreement>;
export type PublicWorkOrder = z.infer<typeof publicWorkOrder>;
export type PayeeWorkOrderRequest = z.infer<typeof payeeWorkOrderRequest>;
export type PayeeCompensationView = z.infer<typeof payeeCompensationView>;
