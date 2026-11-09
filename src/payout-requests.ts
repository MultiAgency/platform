import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { dispatch } from "./agent.js";
import { readStatus } from "./api.js";
import { executes } from "./env.js";
import { withMoneyLock } from "./lock.js";
import { isTerminal, isUnknownOutcome } from "./operation-status.js";
import { isHeld, readOps, settle, type Op } from "./ops.js";
import { type ReviewedPolicy } from "./mandate.js";
import { payoutFailure } from "./payout-failure.js";
import { PublicError } from "./public-error.js";

/**
 * Payouts a caller asks for under its own `requestId` (CONTEXT.md, "Payout request"). The operation's identity is
 * derived from the caller and the `requestId`, and is the provider's idempotency key, so one request is recorded and
 * sent at most once. Every send still goes through `dispatch`: the money lock, no unresolved operation, the write-ahead
 * record, `authorize`, then the one send site.
 */

/** Distinct callers (each app deployment and Organization, each owner) never share a request's identity. */
export const requestKey = (actor: string, requestId: string) =>
  `request:${createHash("sha256").update(`${actor}\n${requestId}`).digest("hex").slice(0, 32)}`;

/** What is recorded and sent: a confidential transfer, or a withdrawal to chain `near` from the confidential balance. */
type Terms = { method: "transfer"; request: { recipient: string; asset: string; amount: string; confidential: true } }
  | { method: "withdraw"; request: { asset: string; amount: string; chain: "near"; recipient: string; confidential: true } };

type Status = Awaited<ReturnType<typeof readStatus>>;
/** What the journal proves about one request, never more; for one that ended `failed`, what the provider says of it. */
async function answer(requestId: string, op: Op | undefined, seen?: Status) {
  const base = { requestId, status: op?.status ?? null, correlationId: op?.correlationId ?? null, code: op?.refused ?? null,
    failureCode: null as string | null, neverExecuted: false };
  if (!op) return { ...base, state: "not_found" as const };
  if (op.refused !== undefined) return { ...base, state: "refused" as const };
  if (op.status === "SUCCESS") return { ...base, state: "succeeded" as const };
  // FAILED and REFUNDED end the operation but don't prove nothing moved (a partial payout fails): a person decides,
  // unless the provider's own record says it never executed. An unread status claims nothing and still answers.
  if (op.status && isTerminal(op.status)) {
    const read = seen ?? (op.correlationId ? await readStatus(op.correlationId).catch(() => undefined) : undefined);
    return { ...base, ...payoutFailure(op.status, read), state: "failed" as const };
  }
  if (isHeld(op)) return { ...base, state: "held" as const };
  if (op.correlationId && op.status && !isUnknownOutcome(op.status)) return { ...base, state: "processing" as const };
  return { ...base, state: "unknown" as const };
}

const callerOf = (actor: string | undefined) => {
  if (!actor) throw new PublicError("A payout request needs the caller's identity from the gateway. Nothing was sent.");
  // Requests are recorded only in the executor's journal: an approve-only copy would answer `not_found` for one it can't see.
  if (!executes()) throw new PublicError("This copy only approves: ask the agent's executor about payout requests. Nothing was sent.");
  return actor;
};
const find = (key: string) => readOps().find((op) => op.idempotencyKey === key);

/**
 * Sends the request once. Asked again, it answers what was recorded and sends nothing; asked with other terms under the
 * same `requestId`, it refuses before anything is sent.
 */
export async function requestPayout(actor: string | undefined, input: { requestId: string; asset: string; delivery: "intents" | { chain: string };
  recipient: string; amount: string; expectedPolicy: ReviewedPolicy; allowDuplicateHeld?: true }) {
  const key = requestKey(callerOf(actor), input.requestId);
  // A withdrawal goes only to chain `near`; any other chain is refused before anything is recorded. Which assets and
  // payees are allowed is `authorize`'s decision, recorded like any refusal.
  if (input.delivery !== "intents" && input.delivery.chain !== "near")
    throw new ORPCError("BAD_REQUEST", { message: "Payouts withdraw only to chain near. Nothing was sent.", data: { kind: "refused", code: "chain_not_supported" } });
  const { recipient, asset, amount } = input;
  const terms: Terms = input.delivery === "intents"
    ? { method: "transfer", request: { recipient, asset, amount, confidential: true } }
    : { method: "withdraw", request: { asset, amount, chain: "near", recipient, confidential: true } };
  const recorded = () => {
    const op = find(key);
    if (op && (op.method !== terms.method || JSON.stringify(op.request) !== JSON.stringify(terms.request)))
      throw new ORPCError("CONFLICT", { message: "This requestId was already used for other terms. Nothing was sent.", data: { kind: "refused", code: "request_conflict" } });
    return op;
  };
  // A repeat answers from the journal without waiting for the money lock: it never sends (one that ended `failed` reads
  // the provider's status of it).
  if (recorded()) return answer(input.requestId, recorded());
  try {
    // A request recorded meanwhile can't be recorded again: the journal refuses a second preparation of one key.
    await withMoneyLock((lock) => dispatch(lock, "payout", terms, undefined, undefined, input.expectedPolicy, key,
      { allowDuplicateHeld: input.allowDuplicateHeld === true }));
  } catch (error) {
    // Recorded: the journal holds the outcome (a refusal, or none proven). Not recorded: nothing reached the send site,
    // and a refusal made before recording keeps its code, so the same requestId can be asked again.
    if (!find(key)) throw error;
  }
  return answer(input.requestId, recorded());
}

/**
 * The request's recorded outcome, refreshed from the provider while it is still moving; one that ended `failed` is read
 * again for how it ended. Sends nothing.
 */
export async function payoutStatus(actor: string | undefined, requestId: string) {
  const key = requestKey(callerOf(actor), requestId);
  const op = find(key);
  let seen: Status | undefined;
  if (op?.correlationId && !(op.status && isTerminal(op.status))) {
    seen = await readStatus(op.correlationId);
    // Recorded only when it moved: polling an unchanged request must not grow the journal every send re-reads.
    if (seen.status !== op.status) settle(op.correlationId, seen.status);
  }
  return answer(requestId, find(key), seen);
}
