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
 * What a grant's label says it is for: the agent's own strategies, its payouts, invoices (the public invoice page), or
 * hires on the agent market. Each purpose (see authorize.ts) names the grant labels that may act for it.
 */
export const GRANT_LABELS = ["treasury", "payout", "invoices", "market"] as const;
/** What an agent is created for, which fixes the policy it starts with (src/policy.ts). */
export const AGENT_ROLES = ["treasury", "payout", "market"] as const;
export type GrantLabel = (typeof GRANT_LABELS)[number];
/**
 * How long a grant lasts: 30 days (`DEFAULT_GRANT_MS`) unless `grant_issue` names an `expiresAt`, which must be at least
 * an hour and at most 365 days ahead, the provider's own maximum (Agent API skills, `references/grants.md`; SDK 0.8.0
 * README). Outside that range it is refused, never clamped: the owner signs the expiry asked for.
 */
export const DEFAULT_GRANT_MS = 30 * 86_400_000;
export const MAX_GRANT_MS = 365 * 86_400_000;
export const MIN_GRANT_MS = 3_600_000;

/** An owner action to prepare for signature (owner-intents.ts `prepare`). */
export const ownerAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agent_create"),
    /** Bounded initial policy for an isolated wallet-owned hosted Market funding observation. */
    creationProfile: z.literal("market-funding-proof").optional(),
    owner: z.object({ type: z.literal("near"), account_id: z.string(), public_key: z.string() }).optional(),
    role: z.enum(AGENT_ROLES).optional(),
    payees: z.array(transferAccount).max(256).optional(),
  }),
  z.object({
    type: z.literal("grant_issue"),
    label: z.enum(GRANT_LABELS).optional(),
    suffix: z.string().min(1).max(64).optional(),
    expectedStrategyDigest: digest.optional(),
    /** When the grant ends (the owner signs it; the provider refuses the agent's sends under it after then): between
     * `MIN_GRANT_MS` and `MAX_GRANT_MS` (365 days) ahead. Absent, `DEFAULT_GRANT_MS` (30 days); under a work order, the order's deadline. */
    expiresAt: z.iso.datetime().optional(),
  }),
  z.object({ type: z.literal("grant_revoke"), grantId: z.string().min(1) }),
  z.object({ type: z.literal("agent_freeze") }),
  z.object({ type: z.literal("agent_unfreeze") }),
  /** Hides the agent and makes the provider refuse its operations; it must be frozen first. Reversible: `agent_restore`, once unfrozen. */
  z.object({ type: z.literal("agent_archive") }),
  z.object({ type: z.literal("agent_restore") }),
  z.object({
    type: z.literal("policy_update"),
    expectedPolicy: reviewedPolicy,
    changes: z.object({
      swap: z.boolean().optional(),
      /** Off by default. Enabling requires the owner's explicit 0–300 bps price-deviation ceiling. */
      limit_order: z.discriminatedUnion("enabled", [
        z.strictObject({ enabled: z.literal(true), max_deviation_bps: z.number().int().min(0).max(300) }),
        z.strictObject({ enabled: z.literal(false) }),
      ]).optional(),
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
  /**
   * Opt out of `duplicate_held_payout`, the refusal of a payout repeating the recipient, asset and amount of one already
   * held for the owner (0.5.5). For callers whose requestIds already make each payout unique: each held payout still needs
   * the owner's vote. An older platform ignores it and keeps refusing.
   */
  allowDuplicateHeld: z.literal(true).optional(),
}).superRefine((input, ctx) => {
  const valid = input.delivery === "intents" ? validIntentsAccount(intentsAccount(input.recipient))
    : !isNearcomAddress(input.recipient) && validIntentsAccount(input.recipient);
  if (!valid) ctx.addIssue({ code: "custom", path: ["recipient"],
    message: input.delivery === "intents" ? "Enter a NEAR Intents account or nearcom: address" : "Enter a NEAR account: a nearcom: address is not on any chain" });
}).transform((input) => input.delivery === "intents" ? { ...input, recipient: intentsAccount(input.recipient) } : input);
export const payoutStatusInput = z.object({ requestId: payoutRequestId });

/**
 * A listed agent's handle on the NEAR AI Agent Market, as its host `<handle>.market.near.ai` takes it: one DNS label of
 * lowercase letters, digits and hyphens. Anything else could point the call, and the payment, at another host.
 */
export const marketHandle = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
/** What the agent is asked to do, as text: its first line a title. The agent's owner reads it; put no secrets in it. */
export const marketBrief = z.string().min(1).max(16_384);
/**
 * A market hire's terms (docs/market.md): what an owner or a DAO approves, paid exactly or not at all. `brief` is the
 * sha256 of the brief's exact text; `asset` and `payTo` are the market's published payee; `amount` is the agent's
 * price in the asset's smallest unit; `maxTimeoutSeconds`, its window plus 10 minutes.
 */
export const hireTerms = z.strictObject({ handle: marketHandle, brief: z.string().regex(/^[0-9a-f]{64}$/), network: z.literal("near:mainnet"),
  asset: z.string().min(1).max(128), payTo: z.string().min(2).max(64), amount: units, maxTimeoutSeconds: z.number().int().positive() });
/** A quote for a hire: the agent and the brief. Moves nothing. */
export const marketQuoteInput = z.object({ handle: marketHandle, brief: marketBrief });
/** A hire under the caller's own `requestId`, paid at most once, only while a fresh quote equals `approved`. */
export const marketHireInput = z.object({ requestId: payoutRequestId, brief: marketBrief, approved: hireTerms });
export const marketStatusInput = z.object({ requestId: payoutRequestId });
/**
 * A deposit address for the asset to fund (default USDC); wNEAR funds withdrawals that arrive as native NEAR. Each call
 * without a `requestId` allocates a new address. With the caller's own `requestId`, the address is asked for at most
 * once: the request is recorded before it is sent, and `depositStatus` answers it by `requestId`.
 */
export const depositInput = z.object({ asset: z.enum(["nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "nep141:wrap.near"]).optional(),
  requestId: payoutRequestId.optional() }).optional();
export const depositStatusInput = z.object({ requestId: payoutRequestId });
export const ownerSubmitInput = z.object({ correlationId: z.string(), signedData: z.record(z.string(), z.unknown()) });
export const ownerStatusInput = z.object({ correlationId: z.string() });
export const executePlanInput = z.object({ planId: z.uuid() });
