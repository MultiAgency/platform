import { generateKey, Near, parseKey } from "near-kit";
import { PublicError } from "../public-error.js";

/**
 * The agent's payment key (docs/market.md): an Ed25519 key whose implicit NEAR account holds at most the hire being
 * paid. The platform writes it into a market agent's settings file at reservation (`MARKET_PAYMENT_KEY`), before the
 * agent exists, so the policy it is created with can name that account as its one withdrawal destination. It is never
 * replaced (funds or an outstanding authorization may sit on it) and never returned by any route. It signs one shape
 * only: a NEP-366 `ft_transfer` of a token to a payee, built here, so no caller can hand it another action.
 */

/** What a delegate action pays; `nonce` and `maxBlockHeight` are read from the chain by the caller and recorded. */
export type DelegateTerms = { asset: string; payTo: string; amount: string; nonce: bigint; maxBlockHeight: bigint };
export type SignedPayment = {
  /** Base64 Borsh `SignedDelegateAction`, the x402 `signedDelegateAction`. */
  signedDelegateAction: string;
  signer: string;
  publicKey: string;
  nonce: string;
  maxBlockHeight: string;
};

/** Signs a payment. The payment key now; the provider's delegate signing once it exists (docs/market.md, ask 1). */
export interface PaymentSigner {
  readonly account: string;
  readonly publicKey: string;
  sign(terms: DelegateTerms): Promise<SignedPayment>;
}

/** The implicit account of an Ed25519 key: its 32 public key bytes in hex. */
export const implicitAccount = (publicKey: { data: Uint8Array }) => Buffer.from(publicKey.data).toString("hex");

/** The x402 shape (market x402-caller skill 0.2.0): `ft_transfer`, 1 yoctoNEAR, 30 Tgas. */
const FT_TRANSFER_GAS = "30 Tgas";

export function keySigner(secretKey: string): PaymentSigner {
  const pair = parseKey(secretKey);
  const account = implicitAccount(pair.publicKey);
  const publicKey = pair.publicKey.toString();
  // No RPC is reached: the nonce and expiry are given, and the key is local.
  const near = new Near({ network: "mainnet", privateKey: secretKey as `ed25519:${string}`, defaultSignerId: account });
  return {
    account,
    publicKey,
    async sign({ asset, payTo, amount, nonce, maxBlockHeight }) {
      if (!/^[1-9][0-9]*$/.test(amount)) throw new Error("A payment amount is a positive integer in the token's smallest unit");
      const { payload } = await near.transaction(account)
        .functionCall(asset, "ft_transfer", { receiver_id: payTo, amount }, { gas: FT_TRANSFER_GAS, attachedDeposit: 1n })
        .delegate({ nonce, maxBlockHeight });
      return { signedDelegateAction: payload, signer: account, publicKey, nonce: nonce.toString(), maxBlockHeight: maxBlockHeight.toString() };
    },
  };
}

/** A new payment key, for a market agent's settings file at reservation. */
export const newPaymentKey = () => generateKey().secretKey;

/** This agent's payment key, from its settings file. */
export function paymentKey(env: NodeJS.ProcessEnv = process.env): PaymentSigner {
  const key = env.MARKET_PAYMENT_KEY;
  if (!key?.startsWith("ed25519:")) throw new PublicError("This agent has no payment key: a market agent is set up by an app.");
  return keySigner(key);
}
