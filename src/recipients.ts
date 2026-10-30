import { accountExists, contractOf, storageRegistered } from "./chain.js";
import { WITHDRAWN } from "./authorize.js";
import { ASSETS } from "./policy.js";

/**
 * Whether a payout's recipient can receive it. NEAR Intents credits any account id, so a payout to a named account that
 * doesn't exist on NEAR can't be recovered, and the provider refuses it (`invalid_address`, per its docs) in a way this
 * server can't yet prove was a refusal: the payout would stay unresolved and block the agent. Implicit ids (64 hex, or
 * `0x` + 40 hex) need no account on NEAR, but are registered on a token like any other.
 */
const implicit = (account: string) => /^[0-9a-f]{64}$/.test(account) || /^0x[0-9a-f]{40}$/.test(account);

/**
 * The token contract a withdrawal's recipient must be registered on (NEP-145), or `null`. A NEP-141 withdrawn to a NEAR
 * account fails unless the receiver is registered on the token, per the NEAR Intents docs; wNEAR arrives as native NEAR,
 * per the provider's docs, so it needs none. Whether the provider's confidential path (paid by 1Click) registers the
 * receiver itself is unobserved, so this refuses any unregistered receiver. An asset a payout may not withdraw isn't read:
 * `authorize` refuses it, by its own code.
 */
export const registrationFor = (asset: string) => asset !== ASSETS.wNEAR && WITHDRAWN.has(asset) ? contractOf(asset) : null;

/** The chain reads, at final finality. Tests replace them. */
export const recipientChain = {
  exists: (account: string) => accountExists(account, { finality: "final" }),
  registered: (contract: string, account: string) => storageRegistered(contract, account, { finality: "final" }),
};

/**
 * `contract`: the token the recipient must be registered on, if any (`registrationFor`). `unchecked` when the chain
 * didn't answer: nothing is known, so nothing is sent.
 */
export async function recipientState(account: string, contract: string | null = null): Promise<"exists" | "absent" | "unregistered" | "unchecked"> {
  try {
    if (!implicit(account) && !(await recipientChain.exists(account))) return "absent";
    return contract === null || (await recipientChain.registered(contract, account)) ? "exists" : "unregistered";
  } catch { return "unchecked"; }
}
