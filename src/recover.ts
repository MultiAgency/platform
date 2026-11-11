import { isMoving, readStatus, StatusMismatch } from "./api.js";
import { markInvoiceUnknown } from "./invoice-store.js";
import { acquireMoneyLock } from "./lock.js";
import { blocksDispatch, isResolved, isTerminal, type Method, type Op, readOps, record } from "./ops.js";
import { contractOf } from "./chain.js";
import { paymentOutcome, readChainView } from "./market/resolution.js";
import { paymentId, type X402Request } from "./market/x402.js";
import { assertSuccessfulOrderEvidence, loadOrderProposal, readOrderCancellation, readOrderFinal, readOrderPlacement, saveOrderPlacement } from "./limit-orders/store.js";
import { orderFinality, refreshOpenOrders, refreshTrackedOrder } from "./limit-orders/observe.js";

/**
 * Resolves money actions left without a proven outcome (a crash, a lost response, an UNCERTAIN
 * status), always under their original idempotency key:
 * - with a correlation id, it reads the status once and records it. Reading is always safe, so
 *   anything may do it unattended, the autopilot included;
 * - without one, submission-attempted remains unknown. Nothing replays it: the provider's lookup
 *   and idempotency semantics are unverified. Prepared invoice operations
 *   can be continued only by resubmitting the original invoice; they have never attempted I/O.
 */

export type Recovery = {
  op: Op;
  /** settled: a final status; refused: a proven refusal; open: still moving, held for approval or a
   * prepared invoice; unknown: acceptance or settlement is unproven; it remains blocked. */
  outcome: "settled" | "refused" | "open" | "unknown";
  status?: string;
  detail?: string;
};

/** For lines written before the method was recorded. */
export const methodOf = (op: Op): Method => {
  if (op.method) return op.method;
  if ("recipient" in op.request) return "transfer";
  if ("origin_asset" in op.request) return "swap";
  if (op.kind === "unshield") return "unshield";
  if (op.kind === "sweep") return "shield";
  throw new Error(`Can't tell how ${op.idempotencyKey} was sent`);
};

/** Every operation without a proven outcome, oldest first: what reconciliation polls. */
export const openOps = () => readOps().filter((op) => !isResolved(op));

/** The unresolved operations: open ones that block new sends. A held payout or a prepared invoice is open but not unresolved. */
export const unresolved = () => readOps().filter(blocksDispatch);

/** Minutes since an action's request was logged. */
export const ageMinutes = (op: Op, now = Date.now()) => Math.round((now - Date.parse(op.at)) / 60_000);

/** Polls only: reads each open operation's status and sends nothing. */
export async function recover(): Promise<Recovery[]> {
  const lock = await acquireMoneyLock({ reconcile: true });
  try {
    const recoveries: Recovery[] = [];
    for (const op of openOps()) {
      try { recoveries.push(await recoverOne(op)); }
      // A status read that fails is no evidence about the operation: its recorded state stays as it was. An
      // answer about another operation is: the invoice behind it becomes unknown.
      catch (error) {
        const mismatch = error instanceof StatusMismatch;
        if (mismatch && op.invoiceId) markInvoiceUnknown(op.idempotencyKey);
        recoveries.push({ op, outcome: "unknown", status: mismatch ? undefined : op.status, detail: `${mismatch ? "" : "status unread: "}${String(error)}` });
      }
    }
    await refreshOpenOrders();
    // Complete safe status-only polling first, then surface a lost funded-order identity. Missing
    // placement evidence must not hide an unrelated unresolved operation from reconciliation.
    assertSuccessfulOrderEvidence(readOps());
    return recoveries;
  } finally {
    await lock.release();
  }
}

/**
 * A market hire's payment, from the chain only (docs/market.md): paid once the key's nonce reached the payment's and
 * its balance dropped by exactly the amount; not charged once the payment expired with the nonce unused, recorded as
 * a refusal (proven never executed). Anything else stays open while the payment could still be relayed, then unknown.
 */
async function recoverPayment(op: Op): Promise<Recovery> {
  const request = op.request as unknown as X402Request;
  const view = await readChainView(request.payer, request.publicKey, contractOf(request.asset));
  const outcome = paymentOutcome({ nonce: BigInt(request.nonce), maxBlockHeight: BigInt(request.maxBlockHeight),
    amount: BigInt(request.amount), balanceAtSigning: BigInt(request.balanceAtSigning) }, view);
  if (outcome === "paid") {
    record({ idempotencyKey: op.idempotencyKey, correlation_id: paymentId(request), status: "SUCCESS" });
    return { op, outcome: "settled", status: "SUCCESS" };
  }
  if (outcome === "not_charged") {
    record({ idempotencyKey: op.idempotencyKey, refused: "x402_not_charged" });
    return { op, outcome: "refused", detail: "x402_not_charged" };
  }
  return view.height <= BigInt(request.maxBlockHeight)
    ? { op, outcome: "open", detail: `the payment can still settle until block ${request.maxBlockHeight}` }
    : { op, outcome: "unknown", detail: "the payment's nonce or the key's balance moved otherwise than this payment would: review required" };
}

async function recoverOne(op: Op): Promise<Recovery> {
  if (op.method === "x402" && op.submissionState === "SUBMISSION_ATTEMPTED") return recoverPayment(op);
  if (op.method === "limit_order_cancel") {
    const proposalId = op.idempotencyKey.startsWith("limit-order-cancel:") ? op.idempotencyKey.slice("limit-order-cancel:".length) : "";
    const placed = proposalId && readOrderPlacement(proposalId);
    const claimed = proposalId && readOrderCancellation(proposalId);
    if (!placed || !claimed || placed.orderId !== claimed.orderId || op.request.orderId !== placed.orderId)
      return { op, outcome: "unknown", detail: "Cancellation claim or placement identity is missing; preserve state for review" };
    const view = await refreshTrackedOrder(proposalId);
    const finality = orderFinality(view);
    if (finality === "complete") {
      record({ idempotencyKey: op.idempotencyKey, cancelFinal: true });
      return { op, outcome: "settled", status: view.fill_status };
    }
    return { op, outcome: finality === "open" ? "open" : "unknown", status: view.fill_status,
      detail: finality === "failed" ? "The order closed but a payout failed; review before any new send"
        : "Cancellation outcome is not payout-final; read again, never repeat the cancel POST" };
  }
  const correlationId = op.correlationId;
  if (!correlationId) {
    if (op.submissionState === "PREPARED") return { op, outcome: "open", status: "PREPARED", detail: "Never submitted. Resubmit the original invoice to continue with its existing key." };
    return { op, outcome: "unknown", detail: "No operation id; acceptance is unknown. Provider deduplication is unverified; review required." };
  }
  const answer = await readStatus(correlationId);
  const { status } = answer;
  if (op.method === "limit_order") {
    const proposalId = op.idempotencyKey.startsWith("limit-order:") ? op.idempotencyKey.slice("limit-order:".length) : "";
    const proposal = proposalId ? loadOrderProposal(proposalId) : null;
    const final = proposal ? readOrderFinal(proposalId) : null;
    if (!proposal || final?.state !== "claimed" || final.operationKey !== op.idempotencyKey || answer.type !== "limit_order")
      throw new StatusMismatch();
    if (status === "SUCCESS") {
      const orderId = answer.details.order_id;
      if (!orderId) return { op, outcome: "unknown", status: op.status,
        detail: "Placement succeeded without an order ID; preserve the journal and investigate" };
      saveOrderPlacement(proposalId, { correlationId, orderId, at: new Date().toISOString() });
    }
  }
  if (status !== op.status) record({ idempotencyKey: op.idempotencyKey, correlation_id: correlationId, status });
  return { op, outcome: isTerminal(status) ? "settled" : status === "UNCERTAIN" || status === "NEEDS_REVIEW" ? "unknown" : "open", status, ...(isMoving(status) && { detail: "still moving" }) };
}

/** Reads one operation's outcome now, as `recover` would, under the same lock. Sends nothing. */
export async function refreshOperation(op: Op): Promise<Recovery> {
  const lock = await acquireMoneyLock({ reconcile: true });
  try { return await recoverOne(op); }
  finally { await lock.release(); }
}

/** Status-only maintenance, independent of strategy execution. */
export function startReconciliation(everyMs = 10_000) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await recover(); }
    catch (error) { console.error("Reconciliation deferred:", String(error)); }
    finally { busy = false; }
  };
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
