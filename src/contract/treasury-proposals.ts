import { z } from "zod";
import { ASSETS } from "./assets.js";
import { payoutRequestId } from "./inputs.js";

/**
 * Treasury proposals (coordination/durable-proposals.md): an app proposes swaps now; the owner approves their exact terms
 * later by signing `proposalText` (NEP-413, recipient the platform host); the platform executes them once, through the
 * same plan execution as any saved plan, under the owner's policy. Pure schemas and the text builder, shared by the
 * platform and apps, so an app can show and check the text it relays.
 */

/** At most this long between proposing and expiry: Sputnik's default `proposal_period`. */
export const MAX_PROPOSAL_MS = 7 * 86_400_000;
/** Proposals per agent neither claimed nor closed; another is refused. */
export const MAX_OPEN_PROPOSALS = 32;
export const MAX_PROPOSAL_LEGS = 8;

/** The platform's assets as the owner's text names them. */
export const PROPOSAL_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  [ASSETS.USDC]: { symbol: "USDC", decimals: 6 },
  [ASSETS.wNEAR]: { symbol: "wNEAR", decimals: 24 },
  [ASSETS.ETH]: { symbol: "ETH", decimals: 18 },
};

const asset = z.enum(Object.values(ASSETS) as [string, ...string[]]);
const amount = z.string().regex(/^[0-9]{1,40}$/).refine(value => BigInt(value) > 0n, "Amount must be positive");
export const proposalId = z.string().regex(/^[a-f0-9]{32}$/);

/** A swap an app chooses: what it spends, buys, and optionally the least it accepts (raised to the quote's floor). */
export const proposalSwap = z.strictObject({ from: asset, to: asset, amount, minAmountOut: amount.optional() })
  .refine(swap => swap.from !== swap.to, "Swap assets must differ");
/**
 * `legs`: the app's chosen swaps, in order, or `"strategy"` for the legs a rebalance toward the owner's strategy picks.
 * `expiresAt`: at most `MAX_PROPOSAL_MS` ahead; the proposal may be approved and executed until then.
 */
export const proposalCreateInput = z.strictObject({
  requestId: payoutRequestId,
  legs: z.union([z.array(proposalSwap).min(1).max(MAX_PROPOSAL_LEGS), z.literal("strategy")]),
  expiresAt: z.iso.datetime(),
  note: z.string().max(280).optional(),
});
/** The owner's NEP-413 signature over the proposal's text, as the app relays it. */
export const proposalSignature = z.strictObject({
  message: z.string().min(1).max(4_096),
  nonce: z.string().min(1).max(64),
  publicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,64}$/),
  signature: z.string().min(1).max(200),
});
export const proposalSigned = z.strictObject({ id: proposalId, signed: proposalSignature });
export const proposalRef = z.strictObject({ id: proposalId });

export const ProposalState = z.enum(["proposed", "approved", "executing", "executed", "stopped", "unknown", "rejected", "withdrawn", "expired", "invalidated"]);
export type ProposalState = z.infer<typeof ProposalState>;

const leg = z.looseObject({ from: z.string(), to: z.string(), amount: z.string(), minAmountOut: z.string() });
/** A proposal as the platform shows it: its signed terms, its state, and what the journal holds for its execution. */
export const proposalView = z.looseObject({
  id: z.string(),
  requestId: z.string(),
  agentId: z.string(),
  deployment: z.string(),
  organization: z.string(),
  source: z.enum(["external", "rebalance"]),
  /** The terms the owner signs: each leg's floor is the least it may return. */
  legs: z.array(leg),
  /** Quotes when proposed: shown, never relied on. */
  quoted: z.array(z.looseObject({ amountOut: z.string(), costBps: z.number(), usdIn: z.number() })),
  policyRevision: z.number().nullable(),
  policyDigest: z.string().nullable(),
  strategyDigest: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  note: z.string().nullable(),
  /** sha256 of the canonical record: named in the owner's text. */
  sha256: z.string(),
  state: ProposalState,
  /** Why it was closed (rejected, withdrawn, expired, invalidated), or null. */
  reason: z.string().nullable(),
  approvedAt: z.string().nullable(),
  /** The plan its execution ran, once claimed. */
  planId: z.string().nullable(),
  /** Its plan's operations in the journal, oldest first. */
  operations: z.array(z.looseObject({ method: z.string().optional(), status: z.string().nullable(), correlationId: z.string().nullable(), refused: z.string().nullable() })),
});
export type ProposalView = z.infer<typeof proposalView>;
export const proposalList = z.looseObject({ proposals: z.array(proposalView) });

/** A raw amount in whole units, exact, without trailing zeros. */
export function tokenAmount(raw: string, decimals: number) {
  const digits = raw.padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
const shown = (asset: string, raw: string) => {
  const token = PROPOSAL_TOKENS[asset];
  return token ? `${tokenAmount(raw, token.decimals)} ${token.symbol} (${raw})` : `${raw} of ${asset}`;
};

type Terms = Pick<ProposalView, "id" | "agentId" | "deployment" | "organization" | "legs" | "policyRevision" | "policyDigest" | "strategyDigest" | "expiresAt" | "sha256">;
/**
 * The exact text the owner signs to approve (or reject) a proposal: the platform accepts only these bytes. The host is
 * the NEP-413 recipient, so it isn't repeated here.
 */
export function proposalText(proposal: Terms, verdict: "approve" | "reject") {
  return [
    `${verdict === "approve" ? "Approve" : "Reject"} Treasury proposal ${proposal.id}`,
    `Agent ${proposal.agentId}`,
    `Proposed by ${proposal.deployment} for ${proposal.organization}`,
    ...proposal.legs.map((leg, i) => `${i + 1}. Swap ${shown(leg.from, leg.amount)} for at least ${shown(leg.to, leg.minAmountOut)}`),
    `Under policy revision ${proposal.policyRevision ?? "none"} (${proposal.policyDigest ?? "none"}), strategy ${proposal.strategyDigest}`,
    `Valid until ${proposal.expiresAt}. Proposal sha256 ${proposal.sha256}.`,
  ].join("\n");
}
