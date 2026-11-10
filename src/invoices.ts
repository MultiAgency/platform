import { agentId } from "./env.js";
import { dispatch, LocalRefusal } from "./agent.js";
import { held } from "./payouts.js";
import { api, readStatus, StatusMismatch } from "./api.js";
import { agreedPayees } from "./authorize.js";
import { acquireMoneyLock, MoneyLockBusy, UnresolvedOperations } from "./lock.js";
import { ASSETS } from "./policy.js";
import { isHeld, isResolved, readOps, record } from "./ops.js";
import type { ReviewedPolicy } from "./mandate.js";
import { currentWorkOrder } from "./work-order-store.js";
import { getInvoice, invoiceId, legacyInvoices, listInvoices, markInvoiceUnknown, noteRevision, prepareInvoice,
  type InvoiceInput, type StoredInvoice } from "./invoice-store.js";

export type Status = "needs_agreement" | "refused" | "busy" | "prepared" | "waiting" | "paying" | "paid" | "failed" | "unknown" | "needs_review";

const MAX_WAITING = 10;
/**
 * Payouts waiting for the owner: those `held` lists (after it settles any that moved on), plus this agent's own still
 * held without an approval the provider names yet, which `held` can't list for a vote but dispatch still reserves.
 */
async function waiting() {
  const listed = await held();
  const shown = new Set(listed.map((payment) => payment.correlationId));
  return listed.length + readOps().filter((op) => isHeld(op) && !shown.has(op.correlationId!)).length;
}
const ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const USDC_DECIMALS = 6;

/** "250" or "250.5" USDC → raw units; null unless it is a positive amount with at most 6 decimals. */
export function usdcUnits(amount: string) {
  const match = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (!match) return null;
  const raw = BigInt(match[1]!) * 10n ** BigInt(USDC_DECIMALS) + BigInt((match[2] ?? "").padEnd(USDC_DECIMALS, "0"));
  return raw > 0n ? raw.toString() : null;
}

/** The invoice as filed, or why it can't be: every field is checked here, whatever proposed it. */
export function validate(input: { payee?: unknown; amount?: unknown; note?: unknown; submission?: unknown }): InvoiceInput | { invalid: string } {
  const payee = typeof input.payee === "string" ? input.payee.trim().toLowerCase() : "";
  if (!ACCOUNT.test(payee)) return { invalid: "payee: a NEAR account such as alice.near" };
  const amount = typeof input.amount === "string" ? usdcUnits(input.amount) : null;
  if (!amount) return { invalid: "amount: a positive USDC amount with at most 6 decimals" };
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note.length > 200 || /\p{Cc}/u.test(note)) return { invalid: "note: at most 200 characters on one line" };
  const submission = typeof input.submission === "string" ? input.submission : "";
  if (!/^[0-9a-f-]{16,64}$/.test(submission)) return { invalid: "form: reload the page and try again" };
  return { payee, amount, note, submission };
}

/** The owner-approved payees; invoices never expand this list. */
export async function agreed() {
  const { policy } = await api.getPolicy(agentId());
  return policy ? agreedPayees(policy) : new Set<string>();
}

const fromApi = (status: string): Status => {
  switch (status) {
    case "PREPARED": return "prepared";
    case "PENDING_APPROVAL": return "waiting";
    case "PROCESSING": case "QUEUED": case "SENT": return "paying";
    case "SUCCESS": return "paid";
    case "FAILED": case "REFUNDED": return "failed";
    case "NEEDS_REVIEW": return "needs_review";
    default: return "unknown";
  }
};
const paymentStatus = (invoice: StoredInvoice): Status => invoice.operation.refused ? "refused" : fromApi(invoice.operation.status ?? "UNKNOWN");

// Both public invoice commands and dashboard commands run in this agent process. The money lock
// also coordinates the existing local CLI tools. Duplicate commands share the persistent identity.
let queue = Promise.resolve();
const serially = <T>(work: () => Promise<T>) => {
  const run = queue.then(work);
  queue = run.then(() => undefined, () => undefined);
  return run;
};

/** `refused` with `code`: Proto's own check refused before submission; the invoice stays prepared on its identity. */
type Filing = { id: string; status: Status; revisionConflict?: boolean; code?: string };

/** A changed revision never changes the original payment or authorizes another attempt. */
export const file = (invoice: InvoiceInput, authenticatedPayee: string, expectedPolicy?: ReviewedPolicy): Promise<Filing> => serially(async () => {
  if (invoice.payee !== authenticatedPayee) throw new Error("Cannot file an invoice for another account");
  const order = currentWorkOrder();
  if (order && (invoice.payee !== order.payee || invoice.amount !== order.amount || invoice.note !== order.note || invoice.submission !== order.id))
    throw new Error("Invoice terms do not match this work order.");
  // Revalidate the internal raw-unit input as well as the HTTP form. No arbitrary action payload.
  if (!/^[0-9]{1,18}$/.test(invoice.amount) || BigInt(invoice.amount) <= 0n ||
      !/^[0-9a-f-]{16,64}$/.test(invoice.submission) || !ACCOUNT.test(invoice.payee) ||
      invoice.note.length > 200 || /\p{Cc}/u.test(invoice.note)) throw new Error("Invalid invoice");
  const id = invoiceId(invoice);
  const legacy = legacyInvoices().find((entry) => entry.id === id);
  if (legacy) return { id, status: "needs_review" }; // do not reconstruct or replay old economic identity
  let known = getInvoice(id);
  if (known && (known.amount !== invoice.amount || known.note !== invoice.note)) {
    noteRevision(invoice);
    return { id, status: "needs_review", revisionConflict: true };
  }
  if (known?.review && known.operation.submissionState === "PREPARED") return { id, status: "needs_review", revisionConflict: true };
  if (known && known.operation.submissionState !== "PREPARED") return { id, status: paymentStatus(known) };
  let lock;
  try {
    lock = await acquireMoneyLock();
    // Reads occur under the same lock as filing, with a final payout-policy check in dispatch.
    if (!(await agreed()).has(invoice.payee)) return { id, status: "needs_agreement" };
    if (await waiting() >= MAX_WAITING) return { id, status: "busy" };
    // All four records are committed before dispatch can reach a provider submission.
    known = prepareInvoice(invoice, ASSETS.USDC);
    if (known.amount !== invoice.amount || known.note !== invoice.note) {
      noteRevision(invoice);
      return { id, status: "needs_review", revisionConflict: true };
    }
    await dispatch(lock, "invoices", { method: "transfer", request: {
      asset: ASSETS.USDC, amount: known.amount, recipient: known.payee, confidential: true,
    } }, undefined, known.operation.idempotencyKey, expectedPolicy);
    return { id, status: paymentStatus(getInvoice(id)!) };
  } catch (error) {
    if (error instanceof MoneyLockBusy || error instanceof UnresolvedOperations) return { id, status: "busy" };
    if (error instanceof LocalRefusal) return { id, status: "refused", code: error.code };
    const persisted = getInvoice(id);
    if (!persisted) throw error;
    // A send/read error is evidence about this attempt, not permission to create a new one.
    markInvoiceUnknown(persisted.operation.idempotencyKey);
    return { id, status: paymentStatus(getInvoice(id)!) };
  } finally { await lock?.release(); }
});

/**
 * Status reads cannot send; terminal outcomes also release the reservation in one transaction. A read
 * that fails is no evidence about the payment, so its recorded state stays as it was; an answer about
 * another operation is evidence something is wrong, so the payment becomes unknown.
 */
async function refreshed(invoice: StoredInvoice): Promise<StoredInvoice> {
  const op = invoice.operation;
  if (!op.correlationId || isResolved(op)) return invoice;
  try {
    const current = await readStatus(op.correlationId);
    record({ idempotencyKey: op.idempotencyKey, correlation_id: op.correlationId, status: current.status });
  } catch (error) {
    if (!(error instanceof StatusMismatch)) return getInvoice(invoice.id)!; // unread: shown as last recorded
    console.error(`invoice ${invoice.id}: ${error.message}`);
    markInvoiceUnknown(op.idempotencyKey);
  }
  return getInvoice(invoice.id)!;
}

/** Only the authenticated payee's read model; no grant, operation request or other invoices. */
export async function mine(payee: string) {
  const invoices = await Promise.all(listInvoices(payee).map(async (saved) => {
    const invoice = await refreshed(saved);
    return { id: invoice.id, amount: invoice.amount, note: invoice.note, filedAt: invoice.at,
      status: invoice.review && invoice.operation.submissionState === "PREPARED" ? "needs_review" as const : paymentStatus(invoice),
      revisionConflict: invoice.review };
  }));
  // Earlier invoices are read-only: a recorded outcome is shown as it was; anything still open needs review.
  const settled: Partial<Record<string, Status>> = { paid: "paid", failed: "failed", refused: "refused" };
  const legacy = legacyInvoices().filter((entry) => entry.payee === payee).map((entry) => ({
    id: entry.id, amount: entry.amount ?? null, note: entry.note ?? "", filedAt: entry.at,
    status: settled[entry.status ?? ""] ?? ("needs_review" as const), revisionConflict: false,
  }));
  return [...invoices, ...legacy].sort((a, b) => b.filedAt.localeCompare(a.filedAt));
}
