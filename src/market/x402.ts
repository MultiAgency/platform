import { createHash } from "node:crypto";
import { z } from "zod";
import { hireTerms, marketHandle } from "../contract/inputs.js";

/**
 * The market's x402 terms, checked before anything is signed (docs/market.md). Pure: the caller fetches the challenge
 * and the market's published payee; this decides whether the payment may be signed and what it signs.
 */

/** One row of a `402` challenge (market x402-caller skill 0.2.0, "Ask for the price"). */
export const PaymentRow = z.object({
  scheme: z.string(),
  network: z.string(),
  asset: z.string(),
  amount: z.string().regex(/^[1-9][0-9]*$/),
  payTo: z.string(),
  maxTimeoutSeconds: z.number().int().positive(),
}).loose();
export type PaymentRow = z.infer<typeof PaymentRow>;

export const Challenge = z.object({ x402Version: z.literal(2), accepts: z.array(PaymentRow) }).loose();

/** `GET https://market.near.ai/.well-known/x402`: the market's payee per network. */
export const Payees = z.object({
  x402Version: z.literal(2),
  recipients: z.array(z.object({ network: z.string(), asset: z.string(), payTo: z.string() }).loose()),
}).loose();
export type Payees = z.infer<typeof Payees>;

export const NETWORK = "near:mainnet";

/** A listed agent's handle, by the contract's rule (`marketHandle`). */
export const isHandle = (handle: string) => marketHandle.safeParse(handle).success;

/** What an owner or a DAO approves: the hire, bound to the brief it was quoted for (`hireTerms`). */
export type HireTerms = z.infer<typeof hireTerms>;

/**
 * What opens a payment key's account: NEAR it holds as its own, for signing (the market's relayer pays the payment's
 * gas), withdrawn once as wNEAR, which arrives as native NEAR. The most a wNEAR top-up may be (`authorize`).
 */
export const OPEN_ACCOUNT_WNEAR = "20000000000000000000000"; // 0.02 NEAR

export const briefDigest = (text: string) => createHash("sha256").update(text).digest("hex");

type Refusal = { code: string; message: string };
const refuse = (code: string, message: string): Refusal => ({ code, message });

/**
 * The terms of a quote, or why it can't be paid: a handle the market's host rule refuses, no `near:mainnet` row, a
 * scheme other than `exact`, or an asset or payee other than the one the market publishes, or a window longer than
 * the caller allows (an unrelayed payment blocks its agent's sends until the window passes).
 */
export function quoteTerms(input: { handle: string; brief: string; challenge: unknown; payees: unknown; maxWindowSeconds: number }):
  { terms: HireTerms; row: PaymentRow } | { refused: Refusal } {
  if (!isHandle(input.handle)) return { refused: refuse("handle_invalid", `"${input.handle}" is not a market handle`) };
  const challenge = Challenge.safeParse(input.challenge);
  if (!challenge.success) return { refused: refuse("quote_unreadable", "The agent's answer is not an x402 challenge") };
  const payees = Payees.safeParse(input.payees);
  if (!payees.success) return { refused: refuse("payee_unreadable", "The market's published payee is unreadable") };
  const index = challenge.data.accepts.findIndex(r => r.network === NETWORK);
  if (index < 0) return { refused: refuse("network_not_offered", `The agent takes no ${NETWORK} payment`) };
  // Checked on the parsed row; signed and sent as the market wrote it: `accepted` must repeat it exactly, key order too.
  const row = challenge.data.accepts[index]!;
  const verbatim = (input.challenge as { accepts: PaymentRow[] }).accepts[index]!;
  if (row.scheme !== "exact") return { refused: refuse("scheme_not_supported", `Only the exact scheme is signed, not ${row.scheme}`) };
  const [payee, ...others] = payees.data.recipients.filter(r => r.network === NETWORK);
  if (!payee || others.length || payee.asset !== row.asset || payee.payTo !== row.payTo)
    return { refused: refuse("payee_not_published", `The quote asks for payment to ${row.payTo} in ${row.asset}, not the market's published payee`) };
  if (row.maxTimeoutSeconds > input.maxWindowSeconds)
    return { refused: refuse("window_too_long", `The agent's window is ${row.maxTimeoutSeconds} s, longer than the ${input.maxWindowSeconds} s allowed`) };
  const terms: HireTerms = { handle: input.handle, brief: briefDigest(input.brief), network: NETWORK, asset: row.asset,
    payTo: row.payTo, amount: row.amount, maxTimeoutSeconds: row.maxTimeoutSeconds };
  return { terms, row: verbatim };
}

/** Whether a fresh quote is still the one approved: every term equal. */
export function sameTerms(approved: HireTerms, now: HireTerms) {
  return (Object.keys(approved) as (keyof HireTerms)[]).every(key => approved[key] === now[key])
    && Object.keys(now).length === Object.keys(approved).length;
}

/**
 * The block a payment expires at, from the latest final block: just under the quote's window. The market refuses a
 * payment valid longer than `maxTimeoutSeconds` from its own view of the chain, which trails ours (mainnet, 2026-11-09:
 * `invalid_exact_near_payload_delegate_action_timeout_window_exceeds_max_timeout` for one valid exactly that long from
 * the latest block), and one expiring before the agent's window, `maxTimeoutSeconds` less 10 minutes (skill 0.2.0).
 */
export const EXPIRY_MARGIN_BLOCKS = 60n;
export const paymentExpiry = (finalHeight: bigint, terms: Pick<HireTerms, "maxTimeoutSeconds">) =>
  finalHeight + BigInt(terms.maxTimeoutSeconds) - EXPIRY_MARGIN_BLOCKS;

/** The `X-PAYMENT` header: the challenge's row verbatim, with one signed delegate action (skill 0.2.0, "Pay"). */
export const paymentHeader = (row: PaymentRow, signedDelegateAction: string) =>
  Buffer.from(JSON.stringify({ x402Version: 2, accepted: row, payload: { signedDelegateAction } })).toString("base64");

/**
 * One x402 payment as the journal records it before anything is signed (docs/market.md, "State"): the hire, the
 * challenge's row verbatim (the market compares `accepted` with the row it sent), and the payment's identity on chain,
 * read under the money lock before signing. `asset` and `amount` repeat the row's in the journal's own terms, so the
 * payment is valued and counted like any other send.
 */
export type X402Request = {
  handle: string;
  /** The brief, as sent: the paid call must repeat the quoted one. */
  brief: string;
  messageId: string;
  row: PaymentRow;
  /** `nep141:<row.asset>`. */
  asset: string;
  amount: string;
  /** The payment key's account and public key. */
  payer: string;
  publicKey: string;
  /** The delegate action's nonce and expiry, and the key's raw balance of the asset when it was read. */
  nonce: string;
  maxBlockHeight: string;
  balanceAtSigning: string;
};

/** The terms a payment pays: what an owner or a DAO approved. */
export const termsOf = (request: X402Request): HireTerms => ({ handle: request.handle, brief: briefDigest(request.brief),
  network: request.row.network as typeof NETWORK, asset: request.row.asset, payTo: request.row.payTo, amount: request.row.amount,
  maxTimeoutSeconds: request.row.maxTimeoutSeconds });

/** A payment's identity on chain: whose nonce it uses. Its journal correlation once it is proven paid. */
export const paymentId = (request: Pick<X402Request, "payer" | "nonce">) => `x402:${request.payer}:${request.nonce}`;

/** The market's published payee for `near:mainnet`, or null when the list doesn't name exactly one. */
export function publishedPayee(value: unknown): { asset: string; payTo: string } | null {
  const parsed = Payees.safeParse(value);
  if (!parsed.success) return null;
  const [payee, ...others] = parsed.data.recipients.filter(r => r.network === NETWORK);
  return payee && !others.length ? { asset: payee.asset, payTo: payee.payTo } : null;
}
