import { grantCommitment, type Policy } from "@near-intents-agent-api/sdk";
import assert from "node:assert/strict";
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
  // Named payout recipients exist on NEAR, and are registered on every token, in this offline world; a test that needs
  // otherwise mocks `recipientChain`.
  recipientChain.exists = async () => true;
  recipientChain.registered = async () => true;
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
/** Every platform asset at $1 with 0 decimals: raw amounts read as dollars, the suites' readable cases. */
export const wholeTokens = () => Object.entries(ASSETS).map(([symbol, asset_id]) => ({ symbol, asset_id, decimals: 0, price: 1 }));
/** Every platform asset at a market-like price with its real decimals, so USD values and quotes carry fractions. */
export const marketTokens = () => [
  { symbol: "USDC", asset_id: ASSETS.USDC, decimals: 6, price: 0.9997 },
  { symbol: "wNEAR", asset_id: ASSETS.wNEAR, decimals: 24, price: 2.37 },
  { symbol: "ETH", asset_id: ASSETS.ETH, decimals: 18, price: 3120.55 },
];
/** A listed price as an exact fraction: 0.9997 is 9997/10000, so a quote never inherits floating-point error. */
const fraction = (price: number) => {
  const [whole, decimals = ""] = String(price).split(".");
  if (!/^\d+$/.test(whole!) || !/^\d*$/.test(decimals) || price <= 0) throw new Error(`price ${price} isn't a positive decimal`);
  return { numerator: BigInt(whole! + decimals), denominator: 10n ** BigInt(decimals.length) };
};
type Listed = { asset_id: string; decimals: number; price: number };
/**
 * A dry swap quote consistent with `tokens`: out = in × priceIn / priceOut in raw units of each token's decimals,
 * rounded down, at no cost. At $1 and 0 decimals for every token it is 1:1.
 */
export function quoteAt(tokens: Listed[], request: { origin_asset: string; destination_asset: string; amount: string }) {
  const find = (asset: string) => tokens.find((t) => t.asset_id === asset) ?? assert.fail(`${asset} isn't listed`);
  const from = find(request.origin_asset), to = find(request.destination_asset);
  const priceIn = fraction(from.price), priceOut = fraction(to.price);
  const out = BigInt(request.amount) * priceIn.numerator * priceOut.denominator * 10n ** BigInt(to.decimals)
    / (priceIn.denominator * priceOut.numerator * 10n ** BigInt(from.decimals));
  return { amount_out: out.toString(), min_amount_out: out.toString() };
}
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
