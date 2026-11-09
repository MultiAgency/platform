import { isTerminal } from "../../../../src/operation-status.js";

/**
 * Provider payment statuses, read as the server reads them: settled as both operation stores do
 * (src/operation-status.ts), on its way as the payee's invoice reads it (src/invoices.ts `fromApi`, "paying"). SENT is
 * recorded once a submission was accepted, before the first provider read.
 */
const MOVING = new Set(["PROCESSING", "QUEUED", "SENT"]);

/** The provider reported how it ended; nothing later changes it. */
export const isSettled = (status: string | undefined) => status !== undefined && isTerminal(status);
/** On its way: says nothing yet about how it ends. */
export const isMoving = (status: string | undefined) => MOVING.has(status ?? "");
