import { z } from "zod";
/** Release changes hosting only; the owner separately signs the provider archive. */
export const releaseInput = z.strictObject({ allowBalance: z.boolean().optional() });
export const releaseBalance = z.object({ source: z.enum(["public", "confidential", "payment-key"]), asset: z.string(), amount: z.string().regex(/^[0-9]+$/) });
export const releaseEvidence = z.object({ agentId: z.string().min(1), at: z.iso.datetime(), archiveCorrelationId: z.string().nullable() });
export const releaseRefusal = z.object({ state: z.literal("refused"), reason: z.enum(["not_executor", "not_archived", "not_frozen", "owner_changed", "unresolved", "held", "owner_action", "limit_orders", "balance"]), balances: z.array(releaseBalance) });
export const releaseCheckOutput = z.discriminatedUnion("state", [releaseEvidence.extend({ state: z.literal("prepared") }), releaseRefusal]);
export const appReleaseOutput = z.discriminatedUnion("state", [releaseEvidence.extend({ state: z.literal("released"), agent: z.string() }), releaseRefusal]);
