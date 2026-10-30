import { z } from "zod";
import { intentsAccount, isNearcomAddress, validIntentsAccount } from "./intents-account.js";

/**
 * Owner procedure inputs: the one source the server implements (src/rpc/*) and clients are typed from
 * (owner-contract.ts). Pure schemas only, so the package stays browser-safe.
 */
export const run = z.object({ execute: z.boolean() });
export const account = z.string().trim().min(2).max(64);
// Only owner-entered Intents destinations: owner identities and provider evidence stay unchanged.
export const transferAccount = z.string().transform(intentsAccount).refine(validIntentsAccount, "Enter a NEAR Intents account or nearcom: address");
export const units = z.string().regex(/^[0-9]{1,40}$/, "an atomic integer amount");
/** A NEAR account paid by withdrawal to chain `near`: never a `nearcom:` address, which is not on any chain. */
export const nearAccount = z.string().trim().refine((value) => !isNearcomAddress(value) && validIntentsAccount(value), "Enter a NEAR account");
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
      /** NEAR accounts paid by withdrawal to chain `near` (no memo); withdrawals are on exactly while there is one. */
      withdrawals: z.array(z.object({ address: nearAccount })).max(64).optional(),
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
   * How it reaches the payee: `intents`, a confidential transfer inside NEAR Intents to an agreed payee (confidential
   * USDC), or `{ chain: "near" }`, a withdrawal from the confidential balance to an agreed NEAR account (wNEAR arrives as
   * native NEAR, or USDC). Other chains are refused before anything is recorded.
   */
  delivery: z.union([z.literal("intents"), z.object({ chain: z.string().min(1).max(64) })]),
  /** A NEAR Intents account or `nearcom:` address for `intents`; a NEAR account for a withdrawal (never `nearcom:`). */
  recipient: z.string().trim().min(1).max(80),
  amount: units,
  expectedPolicy: reviewedPolicy,
}).superRefine((input, ctx) => {
  const valid = input.delivery === "intents" ? validIntentsAccount(intentsAccount(input.recipient))
    : !isNearcomAddress(input.recipient) && validIntentsAccount(input.recipient);
  if (!valid) ctx.addIssue({ code: "custom", path: ["recipient"],
    message: input.delivery === "intents" ? "Enter a NEAR Intents account or nearcom: address" : "Enter a NEAR account: a nearcom: address is not on any chain" });
}).transform((input) => input.delivery === "intents" ? { ...input, recipient: intentsAccount(input.recipient) } : input);
export const payoutStatusInput = z.object({ requestId: payoutRequestId });
/** A deposit address for the asset to fund (default USDC); wNEAR funds withdrawals that arrive as native NEAR. */
export const depositInput = z.object({ asset: z.enum(["nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "nep141:wrap.near"]).optional() }).optional();
export const ownerSubmitInput = z.object({ correlationId: z.string(), signedData: z.record(z.string(), z.unknown()) });
export const ownerStatusInput = z.object({ correlationId: z.string() });
export const executePlanInput = z.object({ planId: z.uuid() });
