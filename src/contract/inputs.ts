import { z } from "zod";
import { intentsAccount, validIntentsAccount } from "./intents-account.js";

/**
 * Owner procedure inputs: the one source the server implements (src/rpc/*) and clients are typed from
 * (owner-contract.ts). Pure schemas only, so the package stays browser-safe.
 */
export const run = z.object({ execute: z.boolean() });
export const account = z.string().trim().min(2).max(64);
// Only owner-entered Intents destinations: owner identities and provider evidence stay unchanged.
export const transferAccount = z.string().transform(intentsAccount).refine(validIntentsAccount, "Enter a NEAR Intents account or nearcom: address");
export const units = z.string().regex(/^[0-9]{1,40}$/, "an atomic integer amount");
/** A USD amount in the policy's budget; null leaves that window uncapped. */
export const usdAmount = z.string().regex(/^\d+(\.\d+)?$/).nullable();
/** Per-asset caps in raw units. */
export const caps = z.record(z.string(), units);
export const reviewedPolicy = z.object({ revision: z.number().int().nonnegative(), digest: z.string().regex(/^sha256:[0-9a-f]{64}$/) });
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/**
 * What a grant's label says it is for: the agent's own strategies, its payouts, or invoices (the
 * public invoice page). Each purpose (see authorize.ts) names the grant labels that may act for it.
 */
export const GRANT_LABELS = ["treasury", "payout", "invoices"] as const;
export type GrantLabel = (typeof GRANT_LABELS)[number];

/** An owner action to prepare for signature (owner-intents.ts `prepare`). */
export const ownerAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agent_create"),
    owner: z.object({ type: z.literal("near"), account_id: z.string(), public_key: z.string() }).optional(),
    role: z.enum(["treasury", "payout"]).optional(),
    payees: z.array(transferAccount).max(256).optional(),
  }),
  z.object({
    type: z.literal("grant_issue"),
    label: z.enum(GRANT_LABELS).optional(),
    suffix: z.string().min(1).max(64).optional(),
    expectedStrategyDigest: digest.optional(),
  }),
  z.object({ type: z.literal("grant_revoke"), grantId: z.string().min(1) }),
  z.object({ type: z.literal("agent_freeze") }),
  z.object({ type: z.literal("agent_unfreeze") }),
  z.object({
    type: z.literal("policy_update"),
    expectedPolicy: reviewedPolicy,
    changes: z.object({
      swap: z.boolean().optional(),
      destinations: z.array(z.object({ address: transferAccount, confidential: z.boolean() })).max(64).optional(),
      assets: z.union([z.literal("any"), z.array(z.string())]).optional(),
      owner_approval: z.boolean().optional(),
      max_actions_per_hour: z.number().int().positive().nullable().optional(),
      budget: z.object({ daily_usd: usdAmount, weekly_usd: usdAmount, monthly_usd: usdAmount }).optional(),
      limits: z
        .object({ per_transaction: caps, hourly: caps, daily: caps, monthly: caps })
        .partial()
        .optional(),
    }),
  }),
  z.object({
    type: z.literal("approval_vote"),
    approvalId: z.uuid(),
    verdict: z.enum(["approve", "reject"]),
    correlationId: z.string(),
  }),
]);

export const ownerPrepareInput = z.object({ action: ownerAction, signer: z.enum(["wallet", "dao"]) });
/**
 * A payout an app or owner asks for under its own `requestId`, stored before calling: the same request is sent at
 * most once, and `payouts/status` answers it by `requestId`. A new attempt is a new `requestId`, after a refusal.
 */
export const payoutRequestId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const payoutRequestInput = z.object({
  requestId: payoutRequestId,
  /** The token paid, as the provider names it (for example `nep141:…`). The agent's signed policy decides which are allowed. */
  asset: z.string().min(1).max(256),
  /**
   * How it reaches the payee: `intents`, a confidential transfer inside NEAR Intents to an agreed payee, or `{ chain }`,
   * a withdrawal to that chain. Today only confidential USDC through `intents` is paid; anything else is refused.
   */
  delivery: z.union([z.literal("intents"), z.object({ chain: z.string().min(1).max(64) })]),
  recipient: transferAccount,
  amount: units,
  expectedPolicy: reviewedPolicy,
});
export const payoutStatusInput = z.object({ requestId: payoutRequestId });
export const ownerSubmitInput = z.object({ correlationId: z.string(), signedData: z.record(z.string(), z.unknown()) });
export const ownerStatusInput = z.object({ correlationId: z.string() });
export const executePlanInput = z.object({ planId: z.uuid() });
