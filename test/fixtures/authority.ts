import { grantCommitment, type Policy } from "@near-intents-agent-api/sdk";
import { ASSETS } from "../../src/policy.js";
import { recipientChain } from "../../src/recipients.js";
import { loadStrategy } from "../../src/strategy.js";
import { strategyLabelSuffix } from "../../src/strategy-digest.js";

export const fixtureOwner = { type: "near" as const, account_id: "owner.near", public_key: "ed25519:fixture" };
export const fixtureWallet = { wallet_id: "wallet-fixture", near_account_id: "wallet.near" };
export function fixtureGrant(label = `treasury:${strategyLabelSuffix(loadStrategy())}`) {
  const expires = Date.now() + 86_400_000;
  return { grant_id: "fixture-grant", agent_id: process.env.AGENT_ID!, wallet_id: fixtureWallet.wallet_id, label,
    issued_at: new Date().toISOString(), expires_at: new Date(expires).toISOString(), revoked_at: null, revoked_reason: null, owner_epoch: 1,
    owner_message: { domain: "near-intents-agent-api.agent-grant.v6" as const, owner: fixtureOwner, tenant_id: "fixture",
      agent_id: process.env.AGENT_ID!, wallet_id: fixtureWallet.wallet_id, label, credential: grantCommitment(process.env.AGENT_GRANT_TOKEN!),
      network: "mainnet" as const, issued_at_ms: Date.now(), expires_at_ms: expires, owner_epoch: 1, nonce: "fixture", recipient: "fixture" } };
}
export function authorityFixture(purpose: "treasury" | "payout" = "payout") {
  // Named payout recipients exist on NEAR in this offline world; a test that needs otherwise mocks `recipientChain.exists`.
  recipientChain.exists = async () => true;
  return {
    getAgent: async () => ({ id: process.env.AGENT_ID!, status: "ACTIVE", archived: false, deleted: false, owner: fixtureOwner, wallet: fixtureWallet }),
    getWallet: async () => fixtureWallet,
    listGrants: async () => [fixtureGrant(purpose === "payout" ? "payout" : undefined)],
    getHistory: async () => ({ data: [], next_cursor: null }),
    getTokens: async () => timedPrices([{ asset_id: ASSETS.USDC, symbol: "USDC", decimals: 6, price: 1 }]),
    getBalances: async (_id: string, { source }: { source: string }) => balanceView(source,
      [{ asset_id: ASSETS.USDC, balance_raw: "1000000000" }]),
  };
}
export const balanceView = <T>(source: string, balances: T[]) => ({ near_account_id: fixtureWallet.near_account_id, source, balances });
export const timedPrices = <T extends object>(tokens: T[], now = Date.now()): Array<Omit<{ price_updated_at: string; price_expires_at: string }, keyof T> & T> => tokens.map((t) => ({
  price_updated_at: new Date(now).toISOString(), price_expires_at: new Date(now + 600_000).toISOString(), ...t }));
/** The provider reports a policy budget in its own format: "25" as "25.00". */
const usd = (value: string | null) => value === null ? null : Number(value).toFixed(2);
export function policyView(policy: Policy, revision = 1) {
  // An uncapped window reports every field null (provider API #51, SDK 0.7.2).
  const budget = Object.fromEntries((["daily", "weekly", "monthly"] as const).map((w) => [w, policy.budget[`${w}_usd`] === null
    ? { limit_usd: null, spent_usd: null, remaining_usd: null, resets_at: null }
    : { limit_usd: usd(policy.budget[`${w}_usd`]), spent_usd: "0", remaining_usd: usd(policy.budget[`${w}_usd`]), resets_at: null }]));
  // The SDK's PolicyView fields, as the provider reports them.
  return { policy, revision, wallet_id: fixtureWallet.wallet_id, status: "APPLIED", provider_policy_synced: true,
    policy_hash: null, applied_at: null, transaction_hash: null, cooldowns: { policy_change_available_at: null, unfreeze_available_at: null },
    usage: { budget, timelock: { delay_ms: 0, scheduled_count: 0 } } };
}
