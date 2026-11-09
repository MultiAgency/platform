import type { PaymentRecord } from "./payment-records.js";
import { isMoving, isSettled } from "./payment-status.js";

/** Already-read observations only. These fields never authorize or recover a payment. */
export type QueueOperation = {
  correlationId?: string;
  idempotencyKey?: string;
  request?: Record<string, unknown>;
  status?: string;
  refused?: string;
  submissionState?: string;
};
export type QueueInvoice = { id: string; at: string; payee: string; review: boolean; operation: QueueOperation };
export type QueueOwnerAction = { stage: string; payment?: { correlationId: string } | null };
export type PaymentQueueEntry<Invoice extends QueueInvoice = QueueInvoice> = {
  id?: string;
  at: string;
  payment?: PaymentRecord;
  invoice?: Invoice;
  needsReview: boolean;
  reason?: string;
  /** Search metadata only; a local operation key is never a provider payment reference. */
  operationKeys?: readonly string[];
};
export type PaymentQueueSources<Invoice extends QueueInvoice = QueueInvoice> = {
  payments: readonly (readonly [string, PaymentRecord])[];
  invoices?: readonly Invoice[];
  activity?: readonly QueueOperation[];
  heldIds?: ReadonlySet<string>;
  pendingIds?: ReadonlySet<string>;
  ownerActions?: readonly QueueOwnerAction[];
};

const outcome = (operation: QueueOperation) => operation.refused !== undefined
  ? `refused:${operation.refused}`
  : operation.submissionState === "PREPARED" ? "PREPARED" : operation.status ?? "UNKNOWN";
const recordedTime = (at: string) => {
  const time = Date.parse(at);
  return Number.isFinite(time) ? time : undefined;
};
const identity = (entry: PaymentQueueEntry) => entry.id ? `payment:${entry.id}` : `invoice:${entry.invoice?.id ?? ""}`;

/**
 * A conservative display filter, not a fresh settlement check. Identity-only history and owner
 * signatures never establish an outcome. Conflicting retained sources remain visible for review.
 * The caller supplies only accessible records and keeps read failures/partial coverage visible.
 */
export function buildPaymentQueue<Invoice extends QueueInvoice = QueueInvoice>(sources: PaymentQueueSources<Invoice>): PaymentQueueEntry<Invoice>[] {
  const invoices = sources.invoices ?? [];
  const activities = new Map<string, QueueOperation[]>();
  for (const operation of sources.activity ?? []) {
    if (!operation.correlationId) continue;
    const records = activities.get(operation.correlationId) ?? [];
    records.push(operation);
    activities.set(operation.correlationId, records);
  }
  const recovering = new Map<string, string>();
  for (const action of sources.ownerActions ?? []) {
    if (action.payment && (action.stage === "prepared" || action.stage === "submitted"))
      recovering.set(action.payment.correlationId, action.stage);
  }
  const entries = new Map<string, PaymentQueueEntry<Invoice>>();
  for (const [id, payment] of sources.payments)
    entries.set(`payment:${id}`, { id, at: payment.at, payment, needsReview: true });
  for (const invoice of invoices) {
    const id = invoice.operation.correlationId;
    const key = id ? `payment:${id}` : `invoice:${invoice.id}`;
    const previous = entries.get(key);
    entries.set(key, { ...previous, id, at: previous?.at || invoice.at, invoice, needsReview: true });
  }

  for (const entry of entries.values()) {
    const { id, invoice } = entry;
    const operations = [...(id ? activities.get(id) ?? [] : []), ...(invoice ? [invoice.operation] : [])];
    entry.operationKeys = [...new Set(operations.flatMap(operation => operation.idempotencyKey ? [operation.idempotencyKey] : []))];
    const outcomes = new Set(operations.map(outcome));
    const recovery = id ? recovering.get(id) : undefined;
    if (invoice?.review) entry.reason = "Invoice changes need review";
    else if (invoice?.operation.submissionState === "PREPARED") entry.reason = "Prepared invoice; never submitted";
    else if (recovery) entry.reason = `Owner action ${recovery}`;
    else if (id && sources.heldIds?.has(id)) entry.reason = "Held at last check";
    else if (id && sources.pendingIds?.has(id)) entry.reason = "Owner approval record needs review";
    else if (outcomes.size > 1) entry.reason = "Retained payment observations disagree";
    else if (outcomes.has("PENDING_APPROVAL")) entry.reason = "Held at last check";
    else if ([...outcomes].some(isMoving)) entry.reason = "Payment processing";
    else if (!operations.length || operations.some(operation => operation.refused === undefined &&
      (operation.submissionState === "PREPARED" || !isSettled(operation.status))))
      entry.reason = "Payment outcome unknown";
    else entry.needsReview = false;
  }

  return [...entries.values()].sort((left, right) => {
    if (left.needsReview !== right.needsReview) return left.needsReview ? -1 : 1;
    const a = recordedTime(left.at), b = recordedTime(right.at);
    // Unknown timing has no invented age; it follows dated records within the same group.
    if (a === undefined && b !== undefined) return 1;
    if (a !== undefined && b === undefined) return -1;
    if (a !== undefined && b !== undefined && a !== b) return left.needsReview ? a - b : b - a;
    const leftId = identity(left), rightId = identity(right);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}

/** Local search over recorded recipient/reference fields; it never discovers or reads a payment. */
export function filterPaymentQueue<Entry extends PaymentQueueEntry>(queue: readonly Entry[], view: "review" | "all", query: string): Entry[] {
  const term = query.trim().toLowerCase();
  return queue.filter(entry => {
    if (view === "review" && !entry.needsReview) return false;
    if (!term) return true;
    const recipient = entry.payment?.request?.recipient;
    const invoiceRecipient = entry.invoice?.operation.request?.recipient;
    return [entry.id, entry.invoice?.id, entry.invoice?.payee,
      typeof recipient === "string" ? recipient : undefined,
      typeof invoiceRecipient === "string" ? invoiceRecipient : undefined,
      entry.invoice?.operation.idempotencyKey, ...(entry.operationKeys ?? [])]
      .some(value => value?.toLowerCase().includes(term));
  });
}
