import type { z } from "zod";
import type { agreementCommand, compensationSend, paymentPreparation, reviewCommand } from "../compensation-contract.js";
import type { executePlanInput, ownerAction, ownerPrepareInput, ownerStatusInput, ownerSubmitInput, payoutRequestInput, payoutStatusInput } from "./inputs.js";

/**
 * Owner procedure inputs as the router accepts them (before server-side parsing). Procedures in the owner contract
 * (owner-contract.ts) take their types from its schemas; test/contract-owner.test.ts proves each type equals the router's.
 */
type ReviewedPolicy = { revision: number; digest: string };
type Strategy = { targetBps: Record<string, number>; minLegUsd: number; maxCostBps: number; autopilot: { everyMin: number; maxUsd: number } };
/** An owner action to prepare for signature, as the contract accepts it. */
export type OwnerAction = z.input<typeof ownerAction>;
type In<T extends z.ZodType> = z.input<T>;

export type OwnerInputs = {
  // Reads
  setup: undefined; instance: undefined; overview: undefined; policyHistory: undefined; activity: undefined; unresolved: undefined; held: undefined;
  "inbox/list": undefined; "autopilot/get": undefined; "autopilot/evidence": { since?: string }; "autopilot/log": { tickId?: string };
  "strategy/get": undefined; "treasury/get": undefined; ledger: undefined; ledgerCsv: undefined; reconcileBooks: undefined; paymentHistory: undefined;
  paymentStatus: { correlationId: string; waitMs?: number }; invoices: undefined; "agreements/list": undefined;
  "owner/status": In<typeof ownerStatusInput>; "owner/pending": undefined; "owner/actions": undefined;
  "compensation/list": undefined; "workOrders/list": undefined; "workOrders/get": { id: string }; "workOrders/status": { id: string; correlationId: string };
  // Mutations
  pay: { recipient: string; asset: string; amount: string; confidential: boolean; expectedPolicy: ReviewedPolicy };
  deposit: undefined; recover: undefined; cancelPreparedInvoice: { id: string }; "inbox/dismiss": { id: string };
  "owner/prepare": In<typeof ownerPrepareInput>; "owner/submit": In<typeof ownerSubmitInput>;
  "payouts/request": In<typeof payoutRequestInput>; "payouts/status": In<typeof payoutStatusInput>;
  "agreements/propose": { id: string; until: string }; "agreements/offer": { payee: string; amount: string; note: string; until: string }; "agreements/decline": { id: string };
  "compensation/agreement": z.input<typeof agreementCommand>; "compensation/review": z.input<typeof reviewCommand>;
  "compensation/prepare": z.input<typeof paymentPreparation>; "compensation/send": z.input<typeof compensationSend>;
  "workOrders/create": { id: string; payee: string; amount: string; note: string; until: string };
  "workOrders/prepare": { id: string; action: "create" | "grant" | "approve" | "reject" | "revoke"; signer: "wallet" | "dao" };
  "workOrders/submit": { id: string; correlationId: string; signedData: Record<string, unknown> };
  "workOrders/deposit": { id: string }; "workOrders/file": { id: string };
  "strategy/save": { strategy: Strategy; expectedDigest: string };
  "autopilot/set": { on: boolean; everyMin: number; maxUsd: number; expectedDigest?: string }; "autopilot/enable": { expectedDigest: string };
  "autopilot/stop": undefined; "autopilot/tick": undefined;
  "treasury/link": { accountId: string }; "treasury/unlink": undefined; "treasury/setConfidential": { confidential: boolean };
  "treasury/fund": { asset: "USDC" | "NEAR"; amount: string };
  externalPlan: { swaps: { from: string; to: string; amount: string; minAmountOut?: string }[] };
  // Streams
  rebalance: undefined; executePlan: In<typeof executePlanInput>; sweep: { execute: boolean }; "steward/propose": { instruction?: string };
};
