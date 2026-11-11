import type { Policy } from "@near-intents-agent-api/sdk";
import type { Action } from "./agent.js";

import { ASSETS } from "./contract/assets.js";
import type { AGENT_ROLES } from "./contract/inputs.js";
export { ASSETS };

/**
 * Treasury spending policy: swaps, configured per-asset caps and a shared USD budget, with no
 * external destinations. Enforcement and window semantics depend on the Agent API and OutLayer;
 * see docs/enforcement.md. These caps do not bound portfolio exposure.
 */
export const treasuryPolicy: Policy = {
  frozen: false,
  actions: ["swap"],
  confidential: true,
  owner_approval: false,
  assets: Object.values(ASSETS),
  limits: {
    hourly: {
      [ASSETS.wNEAR]: "2000000000000000000000000", // 2 wNEAR
      [ASSETS.USDC]: "10000000", // 10 USDC
      [ASSETS.ETH]: "4000000000000000", // 0.004 ETH
    },
    daily: {
      [ASSETS.wNEAR]: "5000000000000000000000000", // 5 wNEAR
      [ASSETS.USDC]: "25000000", // 25 USDC
      [ASSETS.ETH]: "10000000000000000", // 0.01 ETH
    },
    monthly: {
      [ASSETS.wNEAR]: "20000000000000000000000000", // 20 wNEAR
      [ASSETS.USDC]: "100000000", // 100 USDC
      [ASSETS.ETH]: "40000000000000000", // 0.04 ETH
    },
  },
  max_actions_per_hour: 20,
  destinations: { mode: "only", list: [] },
  budget: { daily_usd: "25", weekly_usd: "75", monthly_usd: "150" },
  timelock_ms: 0,
};

/**
 * Why `policy` should not let this action through, beyond what the API checks; null when nothing.
 * The provider's asset list restricts what an action spends. This application additionally refuses
 * swaps and limit orders that acquire an unlisted asset, which the agent otherwise could not sell
 * under the same policy.
 */
export function outputAssetRefusal(action: Action, policy: Policy): string | null {
  const output = action.method === "swap" ? action.request.destination_asset
    : action.method === "limit_order" ? action.request.side === "buy" ? action.request.base_asset : action.request.quote_asset
    : null;
  if (output === null || mayBuy(policy.assets, output)) return null;
  return `${action.method === "swap" ? "the swap buys" : "the limit order acquires"} ${output}, outside the policy's assets`;
}

export const mayBuy = (assets: Policy["assets"], asset: string) => assets === "any" || assets.includes(asset);

/**
 * Payout policy: confidential USDC transfers to agreed payees, each requiring owner approval,
 * with configured per-transaction, daily and monthly caps. Enforcement and approval-time rechecks
 * rely on the Agent API and OutLayer; see docs/enforcement.md.
 */
export function payoutPolicy(payees: string[]): Policy {
  return {
    frozen: false,
    actions: ["transfer"],
    confidential: true,
    owner_approval: true,
    assets: [ASSETS.USDC],
    limits: {
      per_transaction: { [ASSETS.USDC]: "25000000" }, // 25 USDC
      daily: { [ASSETS.USDC]: "50000000" }, // 50 USDC
      monthly: { [ASSETS.USDC]: "200000000" }, // 200 USDC
    },
    max_actions_per_hour: 10,
    destinations: {
      mode: "only",
      list: [...new Set(payees)].map((address) => ({ action: "transfer" as const, address, confidential: true })),
    },
    budget: { daily_usd: "50", weekly_usd: null, monthly_usd: "200" },
    timelock_ms: 0,
  };
}

/**
 * Market policy (docs/market.md): withdrawals to chain `near`, only to the agent's payment key, of USDC (each hire's
 * price) and of wNEAR (arriving as native NEAR, to open the key's account). The key pays each hire over x402. The
 * provider caps and budget bound funding withdrawals. The platform also applies the USDC per-transaction cap to each
 * full hire price, including retained key funds. Daily/monthly limits count withdrawals, not the later key payments;
 * the owner tightens or widens them by policy update.
 */
export function marketPolicy(paymentAccount: string): Policy {
  return {
    frozen: false,
    actions: ["withdraw"],
    confidential: true,
    owner_approval: false,
    assets: [ASSETS.USDC, ASSETS.wNEAR],
    limits: {
      per_transaction: { [ASSETS.USDC]: "25000000", [ASSETS.wNEAR]: "50000000000000000000000" }, // 25 USDC, 0.05 wNEAR
      daily: { [ASSETS.USDC]: "50000000" }, // 50 USDC
      monthly: { [ASSETS.USDC]: "200000000" }, // 200 USDC
    },
    max_actions_per_hour: 10,
    destinations: { mode: "only", list: [{ action: "withdraw", chain: "near", address: paymentAccount, memo: null }] },
    budget: { daily_usd: "50", weekly_usd: null, monthly_usd: "200" },
    timelock_ms: 0,
  };
}

/**
 * What an agent is for: managing the book (swaps, no approval), paying agreed payees (approved), or hiring agents on the
 * market (withdrawals to its payment key).
 */
export type AgentRole = (typeof AGENT_ROLES)[number];

/** The role a hosted agent's area binds it to. */
export const roleOf = (area: string | undefined): AgentRole => area === "payables" ? "payout" : area === "market" ? "market" : "treasury";
