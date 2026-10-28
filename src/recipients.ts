import { accountExists } from "./chain.js";

/**
 * Whether a payout's recipient can receive it. NEAR Intents credits any account id, so a payout to a named account that
 * doesn't exist on NEAR can't be recovered, and the provider refuses it (`invalid_address`, per its docs) in a way this
 * server can't yet prove was a refusal: the payout would stay unresolved and block the agent. Implicit ids (64 hex, or
 * `0x` + 40 hex) need no account on NEAR.
 */
const implicit = (account: string) => /^[0-9a-f]{64}$/.test(account) || /^0x[0-9a-f]{40}$/.test(account);

/** The chain read, at final finality. Tests replace `exists`. */
export const recipientChain = { exists: (account: string) => accountExists(account, { finality: "final" }) };

/** `unchecked` when the chain didn't answer: nothing is known, so nothing is sent. */
export async function recipientState(account: string): Promise<"exists" | "absent" | "unchecked"> {
  if (implicit(account)) return "exists";
  try { return (await recipientChain.exists(account)) ? "exists" : "absent"; } catch { return "unchecked"; }
}
