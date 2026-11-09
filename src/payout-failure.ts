/** The provider's status of one operation, as far as how it ended is concerned. */
export type ProviderOutcome = { status: string; failure_code?: unknown; details?: Record<string, unknown> | null };

/** Provider details that say something was submitted, delivered or refunded: any of them, and `neverExecuted` is false. */
const EFFECTS = ["tx_hash", "destination_tx_hash", "refund_tx_hash", "intent_hash", "amount_out", "refunded_amount", "settled_late"];
const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value) ? value : null;

/**
 * How a payout request that ended FAILED or REFUNDED ended, by the provider's own status of that operation (`seen`), only
 * when it agrees with the journal's status. `failureCode` is the provider's `failure_code`. `neverExecuted` is true only
 * for FAILED with the provider's `details.never_executed` and none of `EFFECTS`: per the provider's docs, an owner's
 * rejection of a held payout ends it so, and nothing was sent. False proves nothing either way. Pure: the agent
 * (`src/payout-requests.ts`) and the SDK's payout double share it.
 */
export function payoutFailure(journalStatus: string | null | undefined, seen: ProviderOutcome | undefined) {
  if (!seen || seen.status !== journalStatus) return { failureCode: null, neverExecuted: false };
  const details: Record<string, unknown> = seen.details ?? {};
  return { failureCode: text(seen.failure_code),
    neverExecuted: seen.status === "FAILED" && details.never_executed === true && EFFECTS.every(key => details[key] === undefined || details[key] === null) };
}
