import { isTerminal, isUnknownOutcome } from "./operation-status.js";
import { payoutFailure, type ProviderOutcome } from "./payout-failure.js";

/** What the journal recorded of one payout request: its provider status and identity, or the code it was refused with. */
export type RecordedRequest = { status?: string | null; correlationId?: string | null; refused?: string | null };

/** Whether answering this request reads the provider's status of it: only one that ended FAILED or REFUNDED. */
export const readsProvider = (op: RecordedRequest | undefined) =>
  !!op && op.refused == null && !!op.status && op.status !== "SUCCESS" && isTerminal(op.status);

/**
 * What the journal proves about one request, never more; for one that ended `failed`, what the provider says of it
 * (`seen`, read by the caller when `readsProvider`). Pure: the agent (`src/payout-requests.ts`) and the SDK's payout
 * double share it, so the double can't answer differently from the platform.
 */
export function payoutAnswer(requestId: string, op: RecordedRequest | undefined, seen?: ProviderOutcome) {
  const base = { requestId, status: op?.status ?? null, correlationId: op?.correlationId ?? null, code: op?.refused ?? null,
    failureCode: null as string | null, neverExecuted: false };
  if (!op) return { ...base, state: "not_found" as const };
  if (op.refused != null) return { ...base, state: "refused" as const };
  if (op.status === "SUCCESS") return { ...base, state: "succeeded" as const };
  // FAILED and REFUNDED end the operation but don't prove nothing moved (a partial payout fails): a person decides,
  // unless the provider's own record says it never executed. An unread status claims nothing and still answers.
  if (op.status && isTerminal(op.status)) return { ...base, ...payoutFailure(op.status, seen), state: "failed" as const };
  if (op.status === "PENDING_APPROVAL") return { ...base, state: "held" as const };
  if (op.correlationId && op.status && !isUnknownOutcome(op.status)) return { ...base, state: "processing" as const };
  return { ...base, state: "unknown" as const };
}
