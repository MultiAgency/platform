import { ownerOutputs } from "../contract/owner-outputs.js";
import { os } from "./base.js";

type Read = "setup" | "instance" | "overview" | "policyHistory" | "activity" | "unresolved" | "held" | "inbox/list" | "autopilot/get" | "autopilot/evidence"
  | "autopilot/log" | "strategy/get" | "treasury/get" | "ledger" | "ledgerCsv" | "reconcileBooks" | "paymentHistory" | "paymentStatus" | "payouts/status" | "invoices"
  | "agreements/list" | "owner/status" | "owner/pending" | "owner/actions" | "compensation/list" | "workOrders/list" | "workOrders/get" | "workOrders/status";

/**
 * A read's answer must match its published contract (src/contract/owner-outputs.ts). Validate only: the original value
 * is returned unchanged, so nothing is stripped on the wire. Drift fails loudly here, at the source; reads have nothing
 * to retry or duplicate. Mutations and streams are never validated server-side: a completed action must not report failure.
 */
export const readOutput = (procedure: Read) => os.middleware(async ({ next }) => {
  const result = await next();
  const checked = ownerOutputs[procedure].safeParse(result.output);
  if (!checked.success) {
    console.error(`Read output drift in ${procedure}:`, checked.error.issues.map(issue => `${issue.path.join(".")}: ${issue.code}`).join("; "));
    throw new Error(`Read output drift in ${procedure}`);
  }
  return result;
});
