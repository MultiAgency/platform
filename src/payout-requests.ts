import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { dispatch, LocalRefusal } from "./agent.js";
import { readStatus } from "./api.js";
import { executes } from "./env.js";
import { withMoneyLock } from "./lock.js";
import { isHeld, isTerminal, readOps, settle, type Op } from "./ops.js";
import { type ReviewedPolicy } from "./mandate.js";
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
const UNKNOWN = new Set(["UNCERTAIN", "NEEDS_REVIEW"]);

/** What the journal proves about one request, never more. */
function answer(requestId: string, op: Op | undefined) {
  const base = { requestId, status: op?.status ?? null, correlationId: op?.correlationId ?? null, code: op?.refused ?? null };
  if (!op) return { ...base, state: "not_found" as const };
  if (op.refused !== undefined) return { ...base, state: "refused" as const };
  // FAILED and REFUNDED end the operation but don't prove nothing moved (a partial payout fails): a person decides.
  if (op.status && isTerminal(op.status)) return { ...base, state: op.status === "SUCCESS" ? "succeeded" as const : "failed" as const };
  if (isHeld(op)) return { ...base, state: "held" as const };
  if (op.correlationId && op.status && !UNKNOWN.has(op.status)) return { ...base, state: "processing" as const };
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
  recipient: string; amount: string; expectedPolicy: ReviewedPolicy }) {
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
  // A repeat answers from the journal without waiting for the money lock: it never sends.
  if (recorded()) return answer(input.requestId, recorded());
  try {
    // A request recorded meanwhile can't be recorded again: the journal refuses a second preparation of one key.
    await withMoneyLock((lock) => dispatch(lock, "payout", terms, undefined, undefined, input.expectedPolicy, key));
  } catch (error) {
    // Recorded: the journal holds the outcome (a refusal, or none proven). Not recorded: nothing reached the send site,
    // and a refusal made before recording keeps its code, so the same requestId can be asked again.
    if (!find(key)) {
      if (error instanceof LocalRefusal) throw new ORPCError("BAD_REQUEST", { message: error.detail, data: { kind: "refused", code: error.code } });
      throw error;
    }
  }
  return answer(input.requestId, recorded());
}

/** The request's recorded outcome, refreshed from the provider while it is still moving. Sends nothing. */
export async function payoutStatus(actor: string | undefined, requestId: string) {
  const key = requestKey(callerOf(actor), requestId);
  const op = find(key);
  if (op?.correlationId && !(op.status && isTerminal(op.status))) {
    // Recorded only when it moved: polling an unchanged request must not grow the journal every send re-reads.
    const now = (await readStatus(op.correlationId)).status;
    if (now !== op.status) settle(op.correlationId, now);
  }
  return answer(requestId, find(key));
}
