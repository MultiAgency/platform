import { createIdempotencyKey, type StatusResponse } from "@near-intents-agent-api/sdk";
import { limitOrderText } from "./contract/limit-orders.js";
import { api, waitForStatus } from "./api.js";
import { assertCanSendAfterRelease } from "./release-state.js";
import { assertAllocationCurrent } from "./market/allocation.js";
import { agentId, executes } from "./env.js";
import { assertCanDispatch, assertMoneyLock, type MoneyLock, withMoneyLock } from "./lock.js";
import { mandateDigest, type ReviewedPolicy } from "./mandate.js";
import { recipientState, registrationFor } from "./recipients.js";
import { AuthorizationHeld, claimSubmission, heldOutgoing, isHeld, marketStageKey, provenRefusal, readMarketBindings, readOps, record, submittedSwapValues, type MarketStage } from "./ops.js";
import { recordSubmissionEvidence } from "./submission-evidence.js";
import { authorize, notInForce, type Case, type Purpose } from "./authorize.js";
import type { Plan, PlannedAction } from "./plans.js";
import { loadStrategy } from "./strategy.js";
import { invoiceOperations, markInvoiceUnknown } from "./invoice-store.js";
import { liveGrant } from "./grants.js";
import { rawBalance } from "./holdings.js";
import { tokenUsd } from "./valuation.js";
import { refusalDetails } from "./provider-display.js";
import { workOrderDispatchProblem } from "./work-order-binding.js";
import { PublicError } from "./public-error.js";
import { ASSETS } from "./policy.js";
import { contractOf } from "./chain.js";
import { payees } from "./market/client.js";
import { recordTask } from "./market/evidence.js";
import { paidHire, PaymentNotSubmitted, signedPayment } from "./market/pay.js";
import { legacyMarketFunding, pendingMarketFunding } from "./market/binding-guard.js";
import { paymentKey } from "./market/payment-key.js";
import { readChainView } from "./market/resolution.js";
import { OPEN_ACCOUNT_WNEAR, publishedPayee, sameTerms, termsOf, type HireTerms, type X402Request } from "./market/x402.js";
import { approvalExpired } from "./market/approval.js";
import { calculateLimitOrderSpend, assertLimitOrderPreviewSpend } from "./limit-orders/terms.js";
import { cancellationClaimPhase, claimOrderCancellation, claimOrderProposal, loadOrderProposal, readOrderApproval,
  readOrderFinal, readOrderPlacement, saveOrderPlacement, type OrderProviderView } from "./limit-orders/store.js";
import { orderFinality, refreshTrackedOrder } from "./limit-orders/observe.js";
import { strategyDigest } from "./strategy-digest.js";

/** Every money action runs under the agent's grant, never the owner's key. With none, quoting and sending are refused. */
export function agent() {
  const grantToken = process.env.AGENT_GRANT_TOKEN;
  if (!grantToken) throw new PublicError("This agent has no grant: the owner must issue one before it can quote or send.");
  return api.forGrant(grantToken);
}

type Grant = ReturnType<typeof agent>;
/** Immutable first-submission terms; ambiguous outcomes never authorize replay. */
export type Action =
  | { method: "swap"; request: Parameters<Grant["swap"]>[1] }
  | { method: "transfer"; request: Parameters<Grant["transfer"]>[1] }
  | { method: "shield"; request: Parameters<Grant["shield"]>[1] }
  | { method: "unshield"; request: Parameters<Grant["unshield"]>[1] }
  | { method: "withdraw"; request: Parameters<Grant["withdraw"]>[1] }
  | { method: "limit_order"; request: Parameters<Grant["placeLimitOrder"]>[1] }
  /** A market hire's payment (docs/market.md): signed by the agent's payment key, paid to the market over x402. */
  | { method: "x402"; request: X402Request };
type ProviderAction = Exclude<Action, { method: "x402" | "limit_order" }>;
type LimitOrderAction = Extract<Action, { method: "limit_order" }>;
type CancelOrderAction = { method: "limit_order_cancel"; request: { proposalId: string } };
type X402Action = Extract<Action, { method: "x402" }>;
/** A market hire's payment, taken by the market: its identity on chain and the task it pays for. Its outcome is the chain's. */
export type X402Sent = { paymentId: string; taskId: string; state: string };
/** The hire a market send is for, as approved: what its payment must pay and its top-up may fund. */
export type MarketSend = { hire: HireTerms; bindingKey: string; stage?: MarketStage; approvalExpiresAt?: number; reviewedGrant?: { id: string; expiresAt: string } };

/** First submissions only. Remote deduplication semantics are not assumed. */
const FIRST_SUBMISSION = Symbol("first submission in this dispatch");
export async function send(action: Action, idempotencyKey: string, lock: MoneyLock, permit?: symbol, approvalExpiresAt?: number, marketGrantExpiresAt?: number): Promise<{ correlation_id: string; task?: Awaited<ReturnType<typeof paidHire>>["task"] }> {
  assertMoneyLock(lock);
  assertCanSendAfterRelease();
  if (permit !== FIRST_SUBMISSION) throw new AuthorizationHeld("submission must pass through dispatch; direct replay is blocked");
  const op = readOps().find((op) => op.idempotencyKey === idempotencyKey);
  if (!op || op.refused || op.correlationId || (op.submissionState && op.submissionState !== "PREPARED"))
    throw new AuthorizationHeld("only a recorded, never-submitted operation can initiate a send");
  if (JSON.stringify(op.request) !== JSON.stringify(action.request) || op.method !== action.method)
    throw new AuthorizationHeld("operation terms do not match the recorded request");
  assertCanDispatch(lock, idempotencyKey);
  // No network call precedes the claim. A deadline crossed during the synchronous claim can still be proved
  // never submitted here; after a call begins, an unknown outcome must remain unresolved.
  const [grant, id, options] = [agent(), agentId(), { idempotencyKey }];
  // A payment is signed here, locally: a key that isn't the recorded payer refuses before the claim.
  const payment = action.method === "x402" ? await signedPayment(action.request) : undefined;
  // Signing yields: shutdown, lock ownership or the durable release marker may have changed before the claim.
  assertCanDispatch(lock, idempotencyKey);
  assertCanSendAfterRelease();
  if (approvalExpired(marketGrantExpiresAt)) throw new LocalRefusal("grant_missing", "The market grant expired before this submission. No further payment is attempted.");
  if (approvalExpired(approvalExpiresAt)) throw new LocalRefusal("approval_expired",
    "The DAO's hire approval expired before this submission. Check recorded top-ups; no further payment is attempted.");
  // Commit submission-attempted before network I/O, in SQLite for invoices and JSONL otherwise.
  // A crash after this point is ambiguous even if the request never leaves this host.
  claimSubmission(idempotencyKey, action.request);
  if (approvalExpired(marketGrantExpiresAt)) throw new LocalRefusal("grant_missing", "The market grant expired before the network call. No further payment is attempted.");
  if (approvalExpired(approvalExpiresAt)) throw new LocalRefusal("approval_expired",
    "The DAO's hire approval expired before the network call. Check recorded top-ups; no further payment is attempted.");
  switch (action.method) {
    case "swap":
      return (await grant.swap(id, action.request, options)) as { correlation_id: string };
    case "transfer":
      return grant.transfer(id, action.request, options);
    case "shield":
      return grant.shield(id, action.request, options);
    case "unshield":
      return grant.unshield(id, action.request, options);
    case "withdraw":
      return grant.withdraw(id, action.request, options);
    case "limit_order":
      return grant.placeLimitOrder(id, action.request, options);
    case "x402":
      return paidHire(action.request, payment!, approvalExpiresAt, marketGrantExpiresAt);
  }
}

/** The module-private permit is passed at one call site, reached only through dispatch. */
function submitClaimed(action: Action, idempotencyKey: string, lock: MoneyLock, approvalExpiresAt?: number, marketGrantExpiresAt?: number) {
  return send(action, idempotencyKey, lock, FIRST_SUBMISSION, approvalExpiresAt, marketGrantExpiresAt);
}

/**
 * A strategy send: a saved plan's leg being sent (`null` for a sweep, which has no plan), whether the
 * autopilot sends it, and the clock it is judged by.
 */
export type Sending = { planned: { plan: Plan; leg: PlannedAction } | null; autopilot: boolean; now: () => Date;
  onSubmitted?: (method: Exclude<Action["method"], "withdraw" | "x402" | "limit_order">, correlationId: string) => void };

/**
 * Sends one money action under the money lock and follows it to a stable status. The request is
 * logged with its key, the mandate digest it runs under and its USD value before sending; the
 * correlation id as soon as the API answers; then the outcome. Every action passes `authorize` after
 * it is logged and before anything is sent, so a refusal is logged too and the log shows every
 * attempt. Anything else unanswered stays unresolved, and blocks new money actions until
 * status-only reconciliation proves its outcome.
 */
/**
 * `requestKey`: the operation's identity derived from a caller's request (payout-requests.ts), instead of a new one.
 * `market`: the hire a market send is for (src/market/hire.ts). A payment's outcome is never awaited here: it is the
 * chain's, recorded by reconciliation (src/recover.ts).
 */
export function dispatch(lock: MoneyLock, kind: string, action: X402Action, sending: undefined, preparedKey: undefined, expectedPolicy: ReviewedPolicy | undefined, requestKey: string | undefined, payout: undefined, market: MarketSend): Promise<X402Sent>;
export function dispatch(lock: MoneyLock, kind: string, action: ProviderAction, sending?: Sending, preparedKey?: string, expectedPolicy?: ReviewedPolicy, requestKey?: string, payout?: { allowDuplicateHeld?: boolean }, market?: MarketSend): Promise<StatusResponse>;
export function dispatch(lock: MoneyLock, kind: "limit-order", action: LimitOrderAction, sending: undefined, preparedKey: undefined,
  expectedPolicy: ReviewedPolicy | undefined, requestKey: undefined, payout: undefined, market: undefined,
  order: { proposalId: string }): Promise<StatusResponse>;
export function dispatch(lock: MoneyLock, kind: "limit-order-cancel", action: CancelOrderAction): Promise<OrderProviderView>;
export async function dispatch(lock: MoneyLock, kind: string, action: Action | CancelOrderAction, sending?: Sending, preparedKey?: string, expectedPolicy?: ReviewedPolicy,
  requestKey?: string, payout?: { allowDuplicateHeld?: boolean }, market?: MarketSend, order?: { proposalId: string }): Promise<StatusResponse | X402Sent | OrderProviderView> {
  assertCanSendAfterRelease();
  action = structuredClone(action);
  expectedPolicy = expectedPolicy && { ...expectedPolicy };
  market = market && structuredClone(market);
  if (action.method === "limit_order_cancel") {
    if (kind !== "limit-order-cancel" || sending || preparedKey || expectedPolicy || requestKey || payout || market || order)
      throw new AuthorizationHeld("cancellation must follow its recorded limit order");
    return dispatchLimitOrderCancellation(lock, action.request.proposalId);
  }
  if (action.method === "limit_order") {
    if (kind !== "limit-order" || sending || preparedKey || requestKey || payout || market || !order)
      throw new AuthorizationHeld("a limit order needs its signed Treasury proposal");
    return dispatchLimitOrder(lock, action, expectedPolicy, order.proposalId);
  }
  // An approve-only instance never sends: refused before anything is recorded, so nothing is left open.
  if (!executes()) throw new PublicError("This copy only approves: payouts are sent by the agent's executor on its own host. Nothing was sent.");
  if (preparedKey && !invoiceOperations().some((op) => op.idempotencyKey === preparedKey && op.submissionState === "PREPARED"))
    throw new Error("Invoice operation is not prepared; replay is blocked");
  assertCanDispatch(lock);
  const allocationBinding = market && readMarketBindings().find(b => b.idempotencyKey === market.bindingKey);
  const allocation = allocationBinding ? await assertAllocationCurrent(allocationBinding) : null;
  if (allocation && market) market.approvalExpiresAt = Math.min(market.approvalExpiresAt ?? Infinity, Date.parse(allocation.expiresAt));
  // A payout (a transfer, or a withdrawal to chain `near`) is read against the confidential balance it is paid from, and
  // its payee must exist on NEAR.
  const payee = action.method === "transfer" || (action.method === "withdraw" && action.request.chain === "near") ? action.request.recipient : null;
  const paysOut = payee !== null;
  // Under a cash floor, a planned swap (and its prerequisite shield) also reads the floor's cash, public and
  // confidential: the only send the floor can refuse. This read only decides what to fetch; the send is judged on the
  // strategy read after the provider's answers, so one saved meanwhile refuses it. A floor added meanwhile finds no
  // cash read, which refuses a swap that would lower cash.
  const cashFloor = sending?.planned?.leg.type === "swap" ? loadStrategy().cashFloor : undefined;
  // A market send reads the market's published payee and its payment key's balance: what its payment may pay, and how
  // much a top-up may add. Read before anything is recorded: an unanswered read records nothing.
  const key = market ? paymentKey() : undefined;
  const [view, tokens, grants, shielded, recipient, cashViews, published, keyView] = await Promise.all([
    api.getPolicy(agentId()), api.getTokens(), api.listGrants(agentId()),
    // A payout's funds, so `authorize` can refuse one the wallet can't cover before it goes to a vote.
    paysOut ? api.getBalances(agentId(), { source: "confidential" }) : undefined,
    payee === null ? "exists" as const : recipientState(payee, action.method === "withdraw" ? registrationFor(action.request.asset) : null),
    cashFloor ? Promise.all([api.getBalances(agentId(), { source: "public" }), api.getBalances(agentId(), { source: "confidential" })]) : undefined,
    market && action.method === "x402" ? payees().then(publishedPayee) : undefined,
    key ? readChainView(key.account, key.publicKey, contractOf(ASSETS.USDC)) : undefined,
  ]);
  // A recipient that doesn't exist on NEAR, isn't registered on the token it is withdrawn to, or that the chain couldn't
  // confirm, is refused before anything is recorded: the provider's own refusal, or a failed delivery, would arrive after
  // the send claim, where it can't yet prove nothing was sent.
  // The one exception: a market agent's first wNEAR top-up opens its payment key's implicit account, which receiving
  // NEAR creates (mainnet, 2026-10-20, a withdrawal to such an account settled; docs/market.md).
  const opensPaymentKey = key !== undefined && payee === key.account && action.method === "withdraw" && action.request.asset === ASSETS.wNEAR;
  if (recipient === "absent" && !opensPaymentKey) throw new LocalRefusal("recipient_not_found", `${payee} is not an account on NEAR. Nothing was sent.`);
  if (recipient === "unregistered") throw new LocalRefusal("recipient_not_registered",
    `${payee} isn't registered on this token's contract, so a withdrawal to it would fail. Nothing was sent; the payee registers (storage_deposit) and the request is asked again.`);
  if (recipient === "unchecked") throw new LocalRefusal("recipient_unchecked", "Whether the recipient can receive this on NEAR couldn't be checked. Nothing was sent; try again.");
  const { policy, revision } = view;
  const policyDigest = policy ? mandateDigest(policy) : null;
  const asset = action.method === "swap" ? action.request.origin_asset : action.request.asset;
  const token = tokens.find((t) => t.asset_id === asset);
  const now = (sending?.now() ?? new Date()).getTime();
  const usdIn = tokenUsd(action.request.amount, token, now);
  // No await between this check, the write-ahead record, authorization and submission. A previous
  // send in this run may have become unresolved, or ownership may have been lost during the reads above.
  assertCanDispatch(lock);
  const priorOps = readOps();
  // A market top-up is tied to the hire before funding, and no send may overlap an unproved credit to this shared key.
  // This check is at the dispatch boundary, so another internal caller cannot bypass the hire's binding.
  if (market) {
    const binding = readMarketBindings().find(item => item.idempotencyKey === market.bindingKey);
    const currentKey = paymentKey();
    if (!binding || !key || binding.paymentAccount !== key.account || binding.publicKey !== key.publicKey ||
        binding.paymentAccount !== currentKey.account || binding.publicKey !== currentKey.publicKey ||
        !sameTerms(binding.approved, market.hire))
      throw new LocalRefusal("market_binding_mismatch", "This market send has no matching durable hire and payment key. Nothing was sent.");
    if (binding.fundingSource && (!allocation || binding.fundingSource.message !== allocationBinding?.fundingSource?.message ||
        now >= Date.parse(allocation.expiresAt) || revision !== allocation.reviewedPolicy.revision || policyDigest !== allocation.reviewedPolicy.digest))
      throw new LocalRefusal("market_allocation_changed", "Owner allocation, policy or deadline changed. Nothing was sent.");
    // A locally refused funding stage closes this hire, even after policy changes make another stage or payment
    // otherwise sendable. Its released key may serve a different request, never a continuation of the closed one.
    if (binding.refused || priorOps.some(op => op.refused !== undefined &&
        (op.idempotencyKey === marketStageKey(binding.idempotencyKey, "open") ||
         op.idempotencyKey === marketStageKey(binding.idempotencyKey, "usdc"))))
      throw new LocalRefusal("market_binding_closed", "This hire's funding ended in a recorded refusal. Use its status; no further payment was sent.");
    if (action.method === "withdraw") {
      if (allocation && (market.stage !== "usdc" || BigInt(action.request.amount) > BigInt(allocation.maxTopUpUsdc)))
        throw new LocalRefusal("market_allocation_limit", "This allocation permits only its exact bounded USDC top-up. Nothing was sent.");
      if (!market.stage || requestKey !== marketStageKey(binding.idempotencyKey, market.stage) ||
          action.request.recipient !== binding.paymentAccount ||
          action.request.asset !== (market.stage === "open" ? ASSETS.wNEAR : ASSETS.USDC) ||
          (market.stage === "open" && action.request.amount !== OPEN_ACCOUNT_WNEAR))
        throw new LocalRefusal("market_binding_mismatch", "This top-up does not match its bound funding stage. Nothing was sent.");
    } else if (action.method === "x402") {
      if (binding.fundingOnly)
        throw new LocalRefusal("funding_only", "This request only proves funding and cannot authorize a payment. Nothing was sent.");
      if (market.stage || requestKey !== binding.idempotencyKey || action.request.payer !== binding.paymentAccount ||
          action.request.publicKey !== binding.publicKey || action.request.brief !== binding.brief ||
          !sameTerms(binding.approved, termsOf(action.request)))
        throw new LocalRefusal("market_binding_mismatch", "This payment does not match its bound hire. Nothing was sent.");
    } else throw new LocalRefusal("market_binding_mismatch", "This action is not a bound market send. Nothing was sent.");
    if (pendingMarketFunding(binding.paymentAccount, binding.idempotencyKey))
      throw new LocalRefusal("funding_pending", "This payment key is reserved by another hire or an unproved top-up. No market payment or funding was sent.");
    if (legacyMarketFunding(binding.paymentAccount))
      throw new LocalRefusal("legacy_funding_review_required", "This payment key has an older unbound top-up. Preserve it for reviewed recovery. Nothing was sent.");
  }
  if (payee && !market && legacyMarketFunding(payee))
    throw new LocalRefusal("legacy_funding_review_required", "This payment key has an older unbound top-up. Preserve it for reviewed recovery. Nothing was sent.");
  if (payee && !market && pendingMarketFunding(payee))
    throw new LocalRefusal("funding_pending", "This payment key is reserved by an earlier hire's funding. No payment to it was sent.");
  if (preparedKey && requestKey) throw new Error("An operation has one identity");
  // A request's key was already recorded once: `record` refuses a second preparation, before anything is sent.
  const idempotencyKey = preparedKey ?? requestKey ?? `${kind}:${createIdempotencyKey()}`;
  record({
    at: new Date().toISOString(),
    idempotencyKey,
    kind,
    ...(!preparedKey && { journalVersion: 2 as const }),
    method: action.method,
    request: action.request,
    policyRevision: revision,
    policyDigest,
    usdIn,
    ...(sending?.planned && { planId: sending.planned.plan.id }),
  });
  // A refusal from these local checks comes before any network call, so nothing was submitted. A prepared invoice
  // stays prepared on its identity, to be sent once the cause is fixed (every check runs again); anything else is
  // resolved as refused.
  const refuseLocally = (code: string, message: string): never => {
    if (!preparedKey) record({ idempotencyKey, refused: code });
    throw new LocalRefusal(code, message);
  };
  // Bind a dashboard confirmation to this dispatch's fresh policy read. This is a local
  // precondition, not an atomic commitment by the remote provider to this policy snapshot.
  if (expectedPolicy && (expectedPolicy.revision !== revision || expectedPolicy.digest !== policyDigest)) {
    refuseLocally("reviewed_policy_changed", "The policy changed since review. Refresh and review the payment again.");
  }
  // The provider enforces most of the policy itself; `authorize` refuses what it can't tell apart or
  // doesn't check (what a swap buys, a grant's purpose, a public or duplicate payout, a changed plan).
  const grant = liveGrant(grants, process.env.AGENT_GRANT_TOKEN);
  if (market?.reviewedGrant && (!grant || grant.label !== "market" || grant.grant_id !== market.reviewedGrant.id ||
      Date.parse(grant.expires_at) !== Date.parse(market.reviewedGrant.expiresAt)))
    refuseLocally("reviewed_grant_changed", "The live market grant differs from the reviewed grant. Review again before submitting.");
  const orderProblem = workOrderDispatchProblem(action, preparedKey, policy, grant, now);
  if (orderProblem) refuseLocally("work_order_binding", orderProblem);
  // A payout or invoices grant only pays out (a transfer or a withdrawal): anything else it sends is judged, and refused,
  // as treasury work.
  const payoutGrant = grant?.label === "payout" || grant?.label === "invoices";
  // A market grant only hires: its top-ups and payments are judged as market sends, and a payment always is.
  const purpose: Purpose = preparedKey ? "invoice"
    : grant?.label === "market" || action.method === "x402" ? "market"
    : payoutGrant && (action.method === "transfer" || action.method === "withdraw") ? "payout"
    : sending?.autopilot ? "autopilot"
    : "treasury";
  // A payout request is a payout, judged as one, or nothing: under a grant for other work it would skip the payout checks.
  // A hire's payment carries its request's identity too, and is judged as a market send.
  if (requestKey && purpose !== "payout" && !(purpose === "market" && (action.method === "x402" || action.method === "withdraw" && !!market?.stage)))
    refuseLocally("grant_purpose_denied", "A payout request is sent only under a payout grant; this agent's grant is for other work.");
  const common = { now, agentId: agentId(), view, grant };
  const held = priorOps.filter(isHeld);
  const reserved = held.filter((op) => op.request.asset === asset).reduce((sum, op) => sum + BigInt(String(op.request.amount)), 0n);
  // The floor's cash, less what sends held for the owner's vote would take from it: the reported balance still
  // includes them (as for payouts), and each may yet be approved.
  const committed = heldOutgoing(priorOps);
  const cash = cashFloor && cashViews
    ? Object.fromEntries(cashFloor.assets.map((a) => {
      const left = rawBalance(cashViews[0], a) + rawBalance(cashViews[1], a) - (committed[a] ?? 0n);
      return [a, (left > 0n ? left : 0n).toString()];
    }))
    : null;
  const available = ((shielded ? rawBalance(shielded, asset) : 0n) - reserved).toString();
  const judged: Case = purpose === "autopilot"
    ? { purpose, facts: { ...common, plan: sending?.planned ?? null, strategy: loadStrategy(), tokens, cash,
      submittedSwapValues: sending?.planned ? submittedSwapValues(priorOps, sending.planned.plan.id) : null } }
    : purpose === "treasury"
      ? { purpose, facts: { ...common, plan: sending?.planned ?? null, strategy: loadStrategy(), tokens, cash } }
      : purpose === "payout"
        ? { purpose, facts: { ...common, available, allowDuplicateHeld: payout?.allowDuplicateHeld === true,
          heldPayouts: held.map(({ request: r }) => ({ recipient: String(r.recipient), asset: String(r.asset), amount: String(r.amount) })) } }
        : purpose === "market"
          ? { purpose, facts: { ...common, hire: market?.hire ?? null, paymentAccount: key?.account ?? null, payee: published ?? null,
            keyBalance: keyView ? keyView.balance.toString() : null } }
          : { purpose, facts: { ...common, available } };
  const refusal = authorize(action, judged);
  if (refusal) refuseLocally(refusal.code, refusal.message);
  let sent: Awaited<ReturnType<typeof send>>;
  try {
    sent = await submitClaimed(action, idempotencyKey, lock, market?.approvalExpiresAt,
      market ? Date.parse(grant?.expires_at ?? "") : undefined);
  } catch (error) {
    // Recognized local failures prove no network I/O, even if a deadline crossed after the durable claim.
    if (error instanceof AuthorizationHeld) {
      // Proven local failure before submission; invoice preparation stays available for revalidation.
      if (!preparedKey) record({ idempotencyKey, refused: "local_authorization_held" });
      throw error;
    }
    const code = error instanceof LocalRefusal || error instanceof PaymentNotSubmitted ? error.code : provenRefusal(error);
    if (code) record({ idempotencyKey, refused: code });
    // A generic local signer or release-read error before the durable claim also proves no network call occurred.
    // Once claimed, the same error could have followed a submission and must remain unresolved.
    else if (!preparedKey && readOps().find(op => op.idempotencyKey === idempotencyKey)?.submissionState === "PREPARED")
      record({ idempotencyKey, refused: "never_submitted" });
    else {
      if (preparedKey) markInvoiceUnknown(preparedKey);
      // Keeps the provider's answer beside the journal for a later, separately authorized resolution. Resolves nothing.
      recordSubmissionEvidence(idempotencyKey, error);
    }
    throw error;
  }
  if (action.method === "x402") {
    // Taken by the market. Nothing proves yet whether it settles: reconciliation reads that from the chain. The task id
    // is the only way back to a paid result, kept as evidence beside the journal.
    const task = sent.task!;
    try { recordTask({ idempotencyKey, handle: action.request.handle, taskId: task.id, state: task.status.state }); }
    catch { console.warn(`Market evidence unavailable for ${idempotencyKey}; the task id is ${task.id}.`); }
    return { paymentId: sent.correlation_id, taskId: task.id, state: task.status.state };
  }
  record({ idempotencyKey, correlation_id: sent.correlation_id, status: "SENT" });
  // Observational callback only, after durable acceptance evidence. Never let UI logging alter recovery.
  // A strategy send never withdraws; only strategy sends report progress.
  try { if (action.method !== "withdraw") sending?.onSubmitted?.(action.method, sent.correlation_id); }
  catch { console.warn("Submission progress unavailable; following the recorded operation."); }
  // Once accepted, even a non-retryable status-read error cannot prove the action was refused.
  const settled = await waitForStatus(sent.correlation_id).catch((cause: unknown) => {
    if (preparedKey) markInvoiceUnknown(preparedKey);
    throw new Error(`Outcome unknown for ${sent.correlation_id}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  });
  record({ idempotencyKey, correlation_id: settled.correlation_id, status: settled.status });
  return settled;
}

/**
 * One owner-signed Treasury limit order. Placement is a money action, so the only provider POST is
 * `send` above, after the same durable journal claim as other sends. A placement SUCCESS proves
 * funding and gives an order ID; the order's fills and payouts are separate live observations.
 */
async function dispatchLimitOrder(lock: MoneyLock, action: LimitOrderAction, expectedPolicy: ReviewedPolicy | undefined,
  proposalId: string): Promise<StatusResponse> {
  if (!executes()) throw new PublicError("This copy only approves: the executor places Treasury orders. Nothing was sent.");
  assertCanDispatch(lock);
  const loaded = loadOrderProposal(proposalId);
  const approval = loaded && readOrderApproval(proposalId);
  if (!loaded || !approval || approval.message !== limitOrderText({ ...loaded.record, sha256: loaded.sha256 }, "approve")
    || readOrderFinal(proposalId))
    throw new LocalRefusal("order_not_approved", "This limit order has no unused owner approval. Nothing was sent.");
  const { record: proposal } = loaded;
  if (JSON.stringify(proposal.order) !== JSON.stringify(action.request) || proposal.agentId !== agentId()
    || action.request.confidential !== true)
    throw new LocalRefusal("order_terms_changed", "The order differs from the owner's exact confidential terms. Nothing was sent.");
  const now = Date.now();
  if (Date.parse(proposal.expiresAt) <= now || Date.parse(proposal.order.deadline) <= now)
    throw new LocalRefusal("order_expired", "The order or its approval expired. Nothing was sent.");

  // A dry preview needs only the API key and carries every provider rule a live placement would fail.
  // It also checks the provider's interpretation of the atomic buy or sell spend before we record a send.
  const [view, tokens, grants, preview] = await Promise.all([
    api.getPolicy(agentId()), api.getTokens(), api.listGrants(agentId()),
    api.placeLimitOrder(agentId(), { ...action.request, dry: true }),
  ]);
  assertCanDispatch(lock);
  const unenforced = notInForce(view);
  if (unenforced) throw new LocalRefusal("policy_not_in_force", `The policy is not in force: ${unenforced}. Nothing was sent.`);
  const policyDigest = view.policy ? mandateDigest(view.policy) : null;
  if (view.revision !== proposal.policyRevision || policyDigest !== proposal.policyDigest
    || expectedPolicy && (expectedPolicy.revision !== view.revision || expectedPolicy.digest !== policyDigest))
    throw new LocalRefusal("order_policy_changed", "The policy changed since the owner signed this order. Nothing was sent.");
  const strategy = loadStrategy();
  if (strategyDigest(strategy) !== proposal.strategyDigest)
    throw new LocalRefusal("order_strategy_changed", "The Treasury strategy changed since the owner signed this order. Nothing was sent.");
  const base = tokens.find(t => t.asset_id === action.request.base_asset);
  const quote = tokens.find(t => t.asset_id === action.request.quote_asset);
  if (!base || !quote) throw new LocalRefusal("order_token_unread", "Both order tokens need provider metadata. Nothing was sent.");
  let spend: ReturnType<typeof calculateLimitOrderSpend>;
  try {
    spend = calculateLimitOrderSpend(action.request, { base: base.decimals, quote: quote.decimals });
    assertLimitOrderPreviewSpend(spend, preview.quote);
  } catch {
    throw new LocalRefusal("order_preview_mismatch", "The provider preview does not match the order's exact atomic spend. Nothing was sent.");
  }
  if (spend.spendAsset !== proposal.spendAsset || spend.spendAmount !== proposal.spendAmount
    || spend.outputAsset !== proposal.outputAsset)
    throw new LocalRefusal("order_terms_changed", "The order's signed spend or output changed. Nothing was sent.");
  if (preview.dry !== true || preview.type !== "limit_order" || !Array.isArray(preview.warnings) || preview.warnings.length)
    throw new LocalRefusal("order_preview_warned", "The provider's dry preview does not clear this order. Nothing was sent.");
  const grant = liveGrant(grants, process.env.AGENT_GRANT_TOKEN);
  const judged: Case = { purpose: "treasury", facts: { now: Date.now(), agentId: agentId(), view, grant,
    plan: null, strategy, tokens, cash: null } };
  const refusal = authorize(action, judged);
  if (refusal) throw new LocalRefusal(refusal.code, `${refusal.message}. Nothing was sent.`);

  // Provider reads may outlast the owner's approval or the provider's order deadline.
  // Recheck with no await between this check, the one-way claim, and submission.
  if (Date.parse(proposal.expiresAt) <= Date.now() || Date.parse(proposal.order.deadline) <= Date.now())
    throw new LocalRefusal("order_expired", "The order or its approval expired during preflight. Nothing was sent.");

  // No await between the final lock check, proposal's one-way claim, journal preparation, and the
  // submission claim inside `send`. A crash after claiming may stop this proposal, never replay it.
  assertCanDispatch(lock);
  const idempotencyKey = `limit-order:${proposalId}`;
  if (!claimOrderProposal(proposalId, idempotencyKey))
    throw new LocalRefusal("order_already_claimed", "This order was already claimed. Read its outcome; nothing was sent again.");
  record({ at: new Date().toISOString(), idempotencyKey, kind: "limit-order", journalVersion: 2,
    method: "limit_order", request: action.request, policyRevision: view.revision, policyDigest,
    usdIn: tokenUsd(spend.spendAmount, tokens.find(t => t.asset_id === spend.spendAsset), Date.now()) });
  let sent: Awaited<ReturnType<typeof send>>;
  try { sent = await submitClaimed(action, idempotencyKey, lock); }
  catch (error) {
    if (error instanceof AuthorizationHeld) {
      record({ idempotencyKey, refused: "local_authorization_held" });
    } else {
      const code = provenRefusal(error);
      if (code) record({ idempotencyKey, refused: code });
      else recordSubmissionEvidence(idempotencyKey, error);
    }
    throw error;
  }
  record({ idempotencyKey, correlation_id: sent.correlation_id, status: "SENT" });
  const settled = await waitForStatus(sent.correlation_id);
  if (settled.type !== "limit_order")
    throw new Error(`Outcome unknown for ${sent.correlation_id}: provider returned another action type`);
  if (settled.status === "SUCCESS") {
    const orderId = settled.details.order_id;
    if (!orderId) throw new Error(`Outcome unknown for ${sent.correlation_id}: placement succeeded without an order ID`);
    saveOrderPlacement(proposalId, { correlationId: sent.correlation_id, orderId, at: new Date().toISOString() });
  }
  record({ idempotencyKey, correlation_id: settled.correlation_id, status: settled.status });
  return settled;
}

/** A cancellation has no provider idempotency key or correlation ID. Only a proven pre-submission claim may resume. */
async function dispatchLimitOrderCancellation(lock: MoneyLock, proposalId: string): Promise<OrderProviderView> {
  if (!executes()) throw new PublicError("This copy only approves: the executor cancels Treasury orders. Nothing was sent.");
  const key = `limit-order-cancel:${proposalId}`;
  assertCanDispatch(lock, key);
  const proposal = loadOrderProposal(proposalId);
  const placed = readOrderPlacement(proposalId);
  const final = readOrderFinal(proposalId);
  if (!proposal || !placed || final?.state !== "claimed" || !readOrderApproval(proposalId))
    throw new LocalRefusal("order_not_placed", "Only a placed, owner-approved order can be canceled here. Nothing was sent.");
  const prior = readOps().find(op => op.idempotencyKey === key);
  const phase = cancellationClaimPhase(proposalId, prior);
  // Once the submission marker exists, a crash or lost answer is ambiguous forever: read only.
  if (phase === "attempted" || phase === "retired") {
    const observed = await refreshTrackedOrder(proposalId);
    if (phase === "attempted" && orderFinality(observed) === "complete" && !prior?.cancelFinal)
      record({ idempotencyKey: key, cancelFinal: true });
    return observed;
  }
  const [grants, current] = await Promise.all([api.listGrants(agentId()), refreshTrackedOrder(proposalId)]);
  if (orderFinality(current) === "complete") {
    if (prior?.submissionState === "PREPARED") record({ idempotencyKey: key, refused: "never_submitted" });
    return current;
  }
  if (orderFinality(current) === "failed") return current;
  const grant = liveGrant(grants, process.env.AGENT_GRANT_TOKEN);
  if (!grant || !(grant.label === "treasury" || grant.label.startsWith("treasury:")))
    throw new LocalRefusal("grant_purpose_denied", "A live Treasury grant is needed to cancel this order. Nothing was sent.");
  const granted = agent(); // Check local token before the irreversible claim.
  assertCanDispatch(lock, key);
  assertCanSendAfterRelease();
  const latest = readOps().find(op => op.idempotencyKey === key);
  if (cancellationClaimPhase(proposalId, latest) !== phase || Boolean(latest) !== Boolean(prior))
    throw new Error("Cancellation claim changed while the money lock was held; preserve state for review");
  if (phase === "none" && !claimOrderCancellation(proposalId, placed.orderId))
    throw new Error("Cancellation claim changed while the money lock was held; preserve state for review");
  const request = { proposalId, orderId: placed.orderId };
  if (!prior) record({ at: new Date().toISOString(), idempotencyKey: key, kind: "limit-order-cancel", journalVersion: 2,
    method: "limit_order_cancel", request, policyRevision: null, policyDigest: null,
    originalOrderPolicyDigest: proposal.record.policyDigest });
  claimSubmission(key, request);
  try { await granted.cancelLimitOrder(agentId(), placed.orderId); }
  catch (error) { recordSubmissionEvidence(key, error); }
  // Cancellation can race a fill. Only a live order read can prove what filled and whether all
  // payouts completed; an unreadable read leaves the cancellation unresolved and blocks new sends.
  const observed = await refreshTrackedOrder(proposalId);
  if (orderFinality(observed) === "complete") record({ idempotencyKey: key, cancelFinal: true });
  return observed;
}

/**
 * A one-time address to fund the account from `originAsset`; incoming funds need no grant. Funds
 * land in the confidential balance, so nothing the agent holds sits in public view.
 */
export async function depositAddress(originAsset: string) {
  const { correlation_id, details } = await api.deposit(
    agentId(),
    { origin_asset: originAsset, confidential: true },
    { idempotencyKey: createIdempotencyKey() },
  );
  // Send funds only here (with the memo, if any); the correlation id is not an address.
  if (!details.deposit_address) throw new Error(`Deposit ${correlation_id} came back without an address`);
  return {
    correlationId: correlation_id,
    address: details.deposit_address,
    memo: details.memo ?? null,
    minAmount: details.min_amount ?? null,
    expiresAt: details.expires_at ?? null,
  };
}

/** A refusal this server makes before sending, shaped like the API's so callers read both alike. */
export class LocalRefusal extends Error {
  readonly errors: { code: string }[];
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.errors = [{ code }];
  }
}

/**
 * The code of a send `dispatch` proved was never made, as the journal records it: refused by this server's checks, held
 * by them before submission, or refused by the provider. Undefined when the send may have been made.
 */
export function sendRefusal(error: unknown) {
  if (error instanceof LocalRefusal) return error.code;
  if (error instanceof AuthorizationHeld) return "local_authorization_held";
  return provenRefusal(error);
}

/** One transfer to a NEAR Intents account. The policy decides whether it may go: a refusal moves nothing. */
export async function pay(request: { asset: string; amount: string; recipient: string; confidential: boolean }, expectedPolicy?: ReviewedPolicy) {
  // Capture before waiting for the money lock; callers cannot alter reviewed terms while queued.
  request = structuredClone(request);
  expectedPolicy = expectedPolicy && { ...expectedPolicy };
  try {
    const settled = await withMoneyLock((lock) => dispatch(lock, "payout", { method: "transfer", request }, undefined, undefined, expectedPolicy));
    return {
      outcome: "settled" as const,
      status: settled.status,
      correlationId: settled.correlation_id,
      failureCode: settled.failure_code,
    };
  } catch (error) {
    const code = error instanceof LocalRefusal ? error.code : provenRefusal(error);
    if (!code) throw error;
    const details = refusalDetails(error);
    return { outcome: "refused" as const, code, ...(Object.keys(details).length ? { details } : {}) };
  }
}
