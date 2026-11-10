import type { OwnerWallet } from "@near-intents-agent-api/sdk";
import { PublicError } from "./public-error.js";
import { roleOf } from "./policy.js";

/** Host-selected ownership is immutable; the browser cannot reassign a reserved executor. */
export function checkHostedCreation(owner: OwnerWallet, signer: "wallet" | "dao", role = "treasury", env = process.env) {
  if (!env.HOSTED_OWNER) return;
  if (signer !== env.HOSTED_OWNER_KIND || owner.type !== "near" ||
      (signer === "wallet" && owner.account_id !== env.HOSTED_OWNER) ||
      (signer === "dao" && env.TREASURY_ACCOUNT !== env.HOSTED_OWNER) ||
      role !== roleOf(env.DASHBOARD_AREA))
    throw new PublicError("This setup is bound to its selected owner and area. Return to your agents to choose another setup.");
}

export function checkHostedTreasury(account: string, env = process.env) {
  if (env.HOSTED_OWNER && env.HOSTED_OWNER_KIND === "dao" && account !== env.HOSTED_OWNER)
    throw new PublicError("This agent's DAO owner cannot be changed or unlinked.");
}
