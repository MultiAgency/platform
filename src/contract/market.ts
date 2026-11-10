import { z } from "zod";
import { ASSETS } from "./assets.js";
import { hireTerms, marketBrief, payoutRequestId } from "./inputs.js";
import { proposalSignature } from "./treasury-proposals.js";

/**
 * A DAO's approval of one market hire (docs/market.md): the DAO votes on the hire's exact terms, signing `hireText`
 * (NEP-413, recipient the platform host) by its own passed vote; the platform relays the signature and the agent pays
 * the hire once. Pure schemas and the text builder, shared by the platform and apps, so an app can show the text its
 * DAO votes on.
 */

/** At most this long between filing a hire's vote and its approval's end: Sputnik's default `proposal_period`. */
export const MAX_HIRE_APPROVAL_MS = 7 * 86_400_000;

type HireTerms = z.infer<typeof hireTerms>;
const USDC_CONTRACT = ASSETS.USDC.slice("nep141:".length);
const shown = (asset: string, amount: string) => {
  if (asset !== USDC_CONTRACT) return `${amount} raw units of ${asset}`;
  const whole = BigInt(amount) / 1_000_000n, fraction = (BigInt(amount) % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} USDC`;
};

/** The text a DAO signs to approve one hire: who asks, which agent of the DAO pays, whom, how much, for what, until when. */
export function hireText(hire: { requestId: string; agentId: string; deployment: string; organization: string; approved: HireTerms; validUntil: string }) {
  const { approved } = hire;
  return [
    `Approve market hire ${hire.requestId}`,
    `Agent ${hire.agentId}`,
    `Requested by ${hire.deployment} for ${hire.organization}`,
    `Hire ${approved.handle}.market.near.ai for ${shown(approved.asset, approved.amount)}, paid over x402 to the market's payee ${approved.payTo} on ${approved.network}`,
    `Brief sha256 ${approved.brief}; the agent's window ${approved.maxTimeoutSeconds} s`,
    `Valid until ${hire.validUntil}. Paid once, only while the agent's quote is these terms.`,
  ].join("\n");
}

/** The DAO's signed approval of one hire, as the platform relays it to the agent. */
export const marketApproveInput = z.strictObject({ requestId: payoutRequestId, brief: marketBrief, approved: hireTerms,
  validUntil: z.iso.datetime(), signed: proposalSignature });
