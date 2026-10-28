import { createIdempotencyKey, type StatusResponse } from "@near-intents-agent-api/sdk";
import { api, waitForStatus } from "./api.js";
import { agentId, executes } from "./env.js";
import { assertCanDispatch, assertMoneyLock, type MoneyLock, withMoneyLock } from "./lock.js";
import { mandateDigest, type ReviewedPolicy } from "./mandate.js";
import { recipientState } from "./recipients.js";
import { AuthorizationHeld, claimSubmission, isHeld, provenRefusal, readOps, record, submittedSwapValues } from "./ops.js";
import { recordSubmissionEvidence } from "./submission-evidence.js";
import { authorize, type Case, type Purpose } from "./authorize.js";
import type { Plan, PlannedAction } from "./plans.js";
import { loadStrategy } from "./strategy.js";
import { invoiceOperations, markInvoiceUnknown } from "./invoice-store.js";
import { liveGrant } from "./grants.js";
import { rawBalance } from "./holdings.js";
import { tokenUsd } from "./valuation.js";
import { refusalDetails } from "./provider-display.js";
import { workOrderDispatchProblem } from "./work-order-binding.js";
import { PublicError } from "./public-error.js";

/** Every money action runs under the agent's grant, never the owner's key. */
export function agent() {
  const grantToken = process.env.AGENT_GRANT_TOKEN;
  if (!grantToken) throw new Error("AGENT_GRANT_TOKEN is not set: issue a grant first");
  return api.forGrant(grantToken);
}

type Grant = ReturnType<typeof agent>;
/** Immutable first-submission terms; ambiguous outcomes never authorize replay. */
export type Action =
  | { method: "swap"; request: Parameters<Grant["swap"]>[1] }
  | { method: "transfer"; request: Parameters<Grant["transfer"]>[1] }
  | { method: "shield"; request: Parameters<Grant["shield"]>[1] }
  | { method: "unshield"; request: Parameters<Grant["unshield"]>[1] };

/** First submissions only. Remote deduplication semantics are not assumed. */
const FIRST_SUBMISSION = Symbol("first submission in this dispatch");
export async function send(action: Action, idempotencyKey: string, lock: MoneyLock, permit?: symbol): Promise<{ correlation_id: string }> {
  assertMoneyLock(lock);
  if (permit !== FIRST_SUBMISSION) throw new AuthorizationHeld("submission must pass through dispatch; direct replay is blocked");
  const op = readOps().find((op) => op.idempotencyKey === idempotencyKey);
  if (!op || op.refused || op.correlationId || (op.submissionState && op.submissionState !== "PREPARED"))
    throw new AuthorizationHeld("only a recorded, never-submitted operation can initiate a send");
  if (JSON.stringify(op.request) !== JSON.stringify(action.request) || op.method !== action.method)
    throw new AuthorizationHeld("operation terms do not match the recorded request");
  assertCanDispatch(lock, idempotencyKey);
  // Every check that can refuse runs before the claim: once claimed, nothing may throw before the
  // network call, or a payment that never left would read "outcome unknown" and block every send.
  const [grant, id, options] = [agent(), agentId(), { idempotencyKey }];
  // Commit submission-attempted before network I/O, in SQLite for invoices and JSONL otherwise.
  // A crash after this point is ambiguous even if the request never leaves this host.
  claimSubmission(idempotencyKey, action.request);
  switch (action.method) {
    case "swap":
      return (await grant.swap(id, action.request, options)) as { correlation_id: string };
    case "transfer":
      return grant.transfer(id, action.request, options);
    case "shield":
      return grant.shield(id, action.request, options);
    case "unshield":
      return grant.unshield(id, action.request, options);
  }
}

/**
 * A strategy send: a saved plan's leg being sent (`null` for a sweep, which has no plan), whether the
 * autopilot sends it, and the clock it is judged by.
 */
export type Sending = { planned: { plan: Plan; leg: PlannedAction } | null; autopilot: boolean; now: () => Date; onSubmitted?: (method: Action["method"], correlationId: string) => void };

/**
 * Sends one money action under the money lock and follows it to a stable status. The request is
 * logged with its key, the mandate digest it runs under and its USD value before sending; the
 * correlation id as soon as the API answers; then the outcome. Every action passes `authorize` after
 * it is logged and before anything is sent, so a refusal is logged too and the log shows every
 * attempt. Anything else unanswered stays unresolved, and blocks new money actions until
 * status-only reconciliation proves its outcome.
 */
/** `requestKey`: the operation's identity derived from a caller's request (payout-requests.ts), instead of a new one. */
export async function dispatch(lock: MoneyLock, kind: string, action: Action, sending?: Sending, preparedKey?: string, expectedPolicy?: ReviewedPolicy, requestKey?: string): Promise<StatusResponse> {
  action = structuredClone(action);
  expectedPolicy = expectedPolicy && { ...expectedPolicy };
  // An approve-only instance never sends: refused before anything is recorded, so nothing is left open.
  if (!executes()) throw new PublicError("This copy only approves: payouts are sent by the agent's executor on its own host. Nothing was sent.");
  if (preparedKey && !invoiceOperations().some((op) => op.idempotencyKey === preparedKey && op.submissionState === "PREPARED"))
    throw new Error("Invoice operation is not prepared; replay is blocked");
  assertCanDispatch(lock);
  const payee = action.method === "transfer" ? action.request.recipient : null;
  const [view, tokens, grants, shielded, recipient] = await Promise.all([
    api.getPolicy(agentId()), api.getTokens(), api.listGrants(agentId()),
    // A payout's funds, so `authorize` can refuse one the wallet can't cover before it goes to a vote.
    action.method === "transfer" ? api.getBalances(agentId(), { source: "confidential" }) : undefined,
    payee === null ? "exists" as const : recipientState(payee),
  ]);
  // A recipient that doesn't exist on NEAR, or that the chain couldn't confirm, is refused before anything is recorded:
  // the provider's own refusal would arrive after the send claim, where it can't yet prove nothing was sent.
  if (recipient === "absent") throw new LocalRefusal("recipient_not_found", `${payee} is not an account on NEAR. Nothing was sent.`);
  if (recipient === "unchecked") throw new LocalRefusal("recipient_unchecked", "Whether the recipient exists on NEAR couldn't be checked. Nothing was sent; try again.");
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
  const orderProblem = workOrderDispatchProblem(action, preparedKey, policy, grant, now);
  if (orderProblem) refuseLocally("work_order_binding", orderProblem);
  // A payout or invoices grant only transfers: anything else it sends is judged, and refused, as treasury work.
  const payoutGrant = grant?.label === "payout" || grant?.label === "invoices";
  const purpose: Purpose = preparedKey ? "invoice"
    : payoutGrant && action.method === "transfer" ? "payout"
    : sending?.autopilot ? "autopilot"
    : "treasury";
  // A payout request is a payout, judged as one, or nothing: under a grant for other work it would skip the payout checks.
  if (requestKey && purpose !== "payout") refuseLocally("grant_purpose_denied", "A payout request is sent only under a payout grant; this agent's grant is for other work.");
  const common = { now, agentId: agentId(), view, grant };
  const held = priorOps.filter(isHeld);
  const reserved = held.filter((op) => op.request.asset === asset).reduce((sum, op) => sum + BigInt(String(op.request.amount)), 0n);
  const available = ((shielded ? rawBalance(shielded, asset) : 0n) - reserved).toString();
  const judged: Case = purpose === "autopilot"
    ? { purpose, facts: { ...common, plan: sending?.planned ?? null, strategy: loadStrategy(), tokens,
      submittedSwapValues: sending?.planned ? submittedSwapValues(priorOps, sending.planned.plan.id) : null } }
    : purpose === "treasury"
      ? { purpose, facts: { ...common, plan: sending?.planned ?? null, strategy: loadStrategy(), tokens } }
      : purpose === "payout"
        ? { purpose, facts: { ...common, available, heldPayouts: held.map(({ request: r }) => ({ recipient: String(r.recipient), asset: String(r.asset), amount: String(r.amount) })) } }
        : { purpose, facts: { ...common, available } };
  const refusal = authorize(action, judged);
  if (refusal) refuseLocally(refusal.code, refusal.message);
  let sent: { correlation_id: string };
  try {
    sent = await send(action, idempotencyKey, lock, FIRST_SUBMISSION);
  } catch (error) {
    // Thrown only before any network call, so nothing was sent.
    if (error instanceof AuthorizationHeld) {
      // Proven local failure before submission; invoice preparation stays available for revalidation.
      if (!preparedKey) record({ idempotencyKey, refused: "local_authorization_held" });
      throw error;
    }
    const code = provenRefusal(error);
    if (code) record({ idempotencyKey, refused: code });
    else {
      if (preparedKey) markInvoiceUnknown(preparedKey);
      // Keeps the provider's answer beside the journal for a later, separately authorized resolution. Resolves nothing.
      recordSubmissionEvidence(idempotencyKey, error);
    }
    throw error;
  }
  record({ idempotencyKey, correlation_id: sent.correlation_id, status: "SENT" });
  // Observational callback only, after durable acceptance evidence. Never let UI logging alter recovery.
  try { sending?.onSubmitted?.(action.method, sent.correlation_id); }
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
