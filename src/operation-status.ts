/**
 * Provider statuses, read one way by both operation stores: the JSONL journal (ops.ts) and invoice payments
 * (invoice-store.ts). Neither store keeps its own list.
 */
const TERMINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"]);
/** The provider itself doesn't know how the operation ended. */
const UNKNOWN = new Set(["UNKNOWN", "UNCERTAIN", "NEEDS_REVIEW"]);

/** A provider status after which nothing more happens to the operation. */
export const isTerminal = (status: string) => TERMINAL.has(status);
/** A provider status that says how it ended is unknown, even to the provider. */
export const isUnknownOutcome = (status: string) => UNKNOWN.has(status);
