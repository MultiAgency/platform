import { z } from "zod";
import { hireTerms, marketBrief, payoutRequestId } from "../contract/inputs.js";
import { signsText, type SignedText } from "../nep413.js";
import { briefDigest } from "./x402.js";

const nonempty = z.string().min(1), hex = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.string().regex(/^[1-9][0-9]*$/);
const landing = z.strictObject({ correlationId: nonempty, destinationTxHash: nonempty, finalHeight: positive });
export const allocationMessageSchema = z.strictObject({
  domain: z.literal("multiagency.market-funding-disposition.v1"), host: z.string().regex(/^[a-z0-9.-]+(?::\d+)?$/),
  providerOrigin: z.url().refine(v => new URL(v).origin === v && v.startsWith("https://")),
  ownerAccount: z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/), ownerPublicKey: nonempty,
  agentId: hex, paymentAccount: hex, paymentPublicKey: nonempty, sourceBindingKey: nonempty,
  sourceOpen: landing, sourceUsdc: landing, sourceUsdcAmount: positive,
  maxTopUpUsdc: z.string().regex(/^(0|[1-9][0-9]*)$/),
  target: z.strictObject({ actor: nonempty, requestId: payoutRequestId, brief: marketBrief, approved: hireTerms }),
  reviewedPolicy: z.strictObject({ revision: z.number().int().nonnegative(), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }),
  expiresAt: z.iso.datetime(), nonce: z.string().refine(v => Buffer.from(v, "base64").length === 32 && Buffer.from(v, "base64").toString("base64") === v),
}).superRefine((m, ctx) => {
  if (briefDigest(m.target.brief) !== m.target.approved.brief)
    ctx.addIssue({ code: "custom", message: "Allocation brief differs from its approved digest" });
  if (BigInt(m.sourceUsdcAmount) > BigInt(m.target.approved.amount))
    ctx.addIssue({ code: "custom", message: "Initial allocation requires the whole source credit in one hire" });
  if (BigInt(m.sourceUsdcAmount) + BigInt(m.maxTopUpUsdc) < BigInt(m.target.approved.amount))
    ctx.addIssue({ code: "custom", message: "Allocation top-up ceiling cannot cover the exact hire" });
});
export type AllocationMessage = z.infer<typeof allocationMessageSchema>;
export const signedAllocationSchema = z.strictObject({ message: nonempty, nonce: nonempty, publicKey: nonempty, signature: nonempty });
export type SignedAllocation = z.infer<typeof signedAllocationSchema>;
export function allocationText(input: AllocationMessage): string { return JSON.stringify(allocationMessageSchema.parse(input)); }
/** Replay checks cryptographic evidence too. Current ownership, expiry and policy are checked separately before use. */
export function parseAllocation(raw: SignedText): AllocationMessage {
  const signed = signedAllocationSchema.parse(raw);
  const message = allocationMessageSchema.parse(JSON.parse(signed.message));
  if (allocationText(message) !== signed.message || signed.nonce !== message.nonce || signed.publicKey !== message.ownerPublicKey ||
      !signsText(signed, message.host, signed.message)) throw new Error("Invalid exact owner allocation signature");
  return message;
}
/** A renewal can change authority/expiry/policy, never its immutable source, target or amount. */
export function allocationIdentity(m: AllocationMessage): string {
  const { ownerPublicKey: _key, nonce: _nonce, expiresAt: _expiry, reviewedPolicy: _policy, ...identity } = m;
  return JSON.stringify(identity);
}
