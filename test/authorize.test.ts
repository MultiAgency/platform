import assert from "node:assert/strict";
import { test } from "node:test";
import type { Policy } from "@near-intents-agent-api/sdk";
import type { Action } from "../src/agent.js";
import { agreedPayees, authorize, type Facts, notInForce, type Purpose } from "../src/authorize.js";
import { mandateDigest } from "../src/mandate.js";
import type { Plan } from "../src/plans.js";
import { ASSETS, payoutPolicy, treasuryPolicy } from "../src/policy.js";
import { DEFAULT_STRATEGY, strategyDigest, strategyLabelSuffix } from "../src/strategy-digest.js";
import { fixtureGrant, policyView, timedPrices } from "./fixtures/authority.js";

/** The single authorization rule, purpose by rule. Pure: no network, no clock, no files. */

process.env.AGENT_ID = "a".repeat(64);
process.env.AGENT_GRANT_TOKEN = "ngt_fixture";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const strategy = { ...DEFAULT_STRATEGY, autopilot: { ...DEFAULT_STRATEGY.autopilot, maxUsd: 10 } };
const USDC = (whole: number) => String(whole * 1_000_000);
const NEAR = (whole: number) => (BigInt(whole) * 10n ** 24n).toString();

const treasury: Policy = { ...treasuryPolicy, actions: ["swap", "transfer"],
  limits: { ...treasuryPolicy.limits, per_transaction: { [ASSETS.USDC]: USDC(50) } } };
const payout = payoutPolicy(["payee.near"]);

const grant = (label: string, change: Partial<ReturnType<typeof fixtureGrant>> = {}) =>
  ({ ...fixtureGrant(label), expires_at: new Date(NOW + 86_400_000).toISOString(), ...change });
const common = (policy: Policy, label: string | null) => ({
  now: NOW, agentId: process.env.AGENT_ID!,
  view: policyView(policy, 11) as Facts["payout"]["view"], grant: label === null ? undefined : grant(label),
});
const tokens = timedPrices([
  { asset_id: ASSETS.USDC, symbol: "USDC", decimals: 6, price: 1 },
  { asset_id: ASSETS.wNEAR, symbol: "wNEAR", decimals: 24, price: 2 },
], NOW) as Facts["treasury"]["tokens"];

const swap = (to: string = ASSETS.USDC, amount = NEAR(1)): Action =>
  ({ method: "swap", request: { origin_asset: ASSETS.wNEAR, destination_asset: to, amount, confidential: true } as never });
const pay = (recipient = "payee.near", amount = USDC(1), asset: string = ASSETS.USDC, confidential = true): Action =>
  ({ method: "transfer", request: { recipient, asset, amount, confidential } });

function facts(purpose: Purpose, change: Record<string, unknown> = {}): never {
  const base = {
    treasury: { ...common(treasury, "treasury:anything"), plan: null, strategy, tokens },
    autopilot: { ...common(treasury, `treasury:${strategyLabelSuffix(strategy)}`), plan: null, strategy, tokens, submittedSwapValues: [] },
    payout: { ...common(payout, "payout"), available: USDC(100), heldPayouts: [] },
    invoice: { ...common(payout, "invoices"), available: USDC(100) },
    approval: common(payout, null),
  }[purpose];
  return { ...base, ...change } as never;
}
const actionFor = (purpose: Purpose): Action => purpose === "autopilot"
  ? { method: "shield", request: { asset: ASSETS.wNEAR, amount: NEAR(1) } }
  : purpose === "treasury" ? swap() : pay();
const PURPOSES: Purpose[] = ["treasury", "autopilot", "payout", "invoice", "approval"];
const code = (purpose: Purpose, action: Action, change: Record<string, unknown> = {}) => authorize(action, { purpose, facts: facts(purpose, change) })?.code ?? "ok";

test("each purpose's baseline is authorized", () => {
  for (const purpose of PURPOSES) assert.equal(code(purpose, actionFor(purpose)), "ok", purpose);
});

test("a policy not in force is refused for every purpose", () => {
  for (const purpose of PURPOSES) {
    const view = facts(purpose) as { view: Record<string, unknown> & { policy: Policy } };
    for (const change of [{ status: "PENDING" }, { provider_policy_synced: false }, { policy: { ...view.view.policy, frozen: true } }, { policy: null }])
      assert.equal(code(purpose, actionFor(purpose), { view: { ...view.view, ...change } }), "policy_not_in_force", `${purpose} ${Object.keys(change)}`);
  }
});

test("the dashboard reads why a policy isn't in force from the same predicate authorize refuses with", () => {
  const { view } = common(treasury, null);
  assert.equal(notInForce(view), null);
  assert.equal(notInForce({ ...view, policy: null }), "no policy is applied");
  assert.equal(notInForce({ ...view, status: "SIGNED" }), "revision 11 is not applied (SIGNED)");
  assert.equal(notInForce({ ...view, provider_policy_synced: false }), "revision 11 is not yet synchronized with the provider");
  assert.equal(notInForce({ ...view, policy: { ...view.policy!, frozen: true } }), "the agent is frozen");
});

test("sends need a live grant whose label allows the purpose; approval votes need none", () => {
  for (const purpose of ["treasury", "autopilot", "payout", "invoice"] as const) {
    assert.equal(code(purpose, actionFor(purpose), { grant: undefined }), "grant_missing", purpose);
    const live = (facts(purpose) as { grant: ReturnType<typeof grant> }).grant;
    assert.equal(code(purpose, actionFor(purpose), { grant: { ...live, revoked_at: new Date(NOW).toISOString() } }), "grant_missing", purpose);
    assert.equal(code(purpose, actionFor(purpose), { grant: { ...live, expires_at: new Date(NOW).toISOString() } }), "grant_missing", purpose);
  }
  assert.equal(code("approval", pay()), "ok");
  // Labels: treasury takes `treasury` and `treasury:*`; the autopilot only this strategy's; payouts `payout` or `invoices`.
  assert.equal(code("treasury", swap(), { grant: grant("treasury") }), "ok");
  assert.equal(code("treasury", swap(), { grant: grant("payout") }), "grant_purpose_denied");
  assert.equal(code("autopilot", swap(), { grant: grant("treasury") }), "grant_purpose_denied");
  assert.equal(code("autopilot", swap(), { grant: grant("treasury:0123456789abcdef0123456789abcdef") }), "grant_purpose_denied");
  assert.equal(code("payout", pay(), { grant: grant("invoices") }), "ok");
  assert.equal(code("payout", pay(), { grant: grant("treasury") }), "grant_purpose_denied");
  assert.equal(code("invoice", pay(), { grant: grant("treasury:anything") }), "grant_purpose_denied");
});

test("an approval over the policy's per-transaction cap is refused; sends leave the cap to the provider", () => {
  assert.equal(code("approval", pay("payee.near", USDC(25))), "ok");
  assert.equal(code("approval", pay("payee.near", String(25_000_001))), "per_transaction_exceeded");
  for (const purpose of ["payout", "invoice"] as const) assert.equal(code(purpose, pay("payee.near", String(25_000_001))), "ok", purpose);
});

test("a swap may buy only an asset in the policy, whoever sends it", () => {
  const USDT = "nep141:usdt.tether-token.near";
  assert.equal(code("treasury", swap(USDT)), "asset_out_not_allowed");
  assert.equal(code("autopilot", swap(USDT)), "asset_out_not_allowed");
  assert.equal(code("treasury", swap(ASSETS.ETH)), "ok");
});

test("payouts, invoices and approvals are confidential USDC transfers", () => {
  for (const purpose of ["payout", "invoice", "approval"] as const) {
    assert.equal(code(purpose, pay("payee.near", "1000000", ASSETS.wNEAR)), "transfer_not_allowed", purpose);
    assert.equal(code(purpose, pay("payee.near", USDC(1), ASSETS.USDC, false)), "transfer_not_allowed", purpose);
    assert.equal(code(purpose, swap()), "transfer_not_allowed", purpose);
  }
});

test("a payout may withdraw wNEAR or USDC to an agreed NEAR account, from the confidential balance; invoices and approvals never withdraw", () => {
  const withdrawing: Policy = { ...payout, actions: ["transfer", "withdraw"], assets: [ASSETS.USDC, ASSETS.wNEAR],
    destinations: { mode: "only", list: [...payout.destinations.list, { action: "withdraw", chain: "near", address: "payee.near", memo: null }] } };
  const view = policyView(withdrawing, 11);
  const withdraw = (change: Record<string, unknown> = {}): Action =>
    ({ method: "withdraw", request: { asset: ASSETS.wNEAR, amount: "1000", chain: "near", recipient: "payee.near", confidential: true, ...change } as never });
  const payoutCode = (action: Action, available = "5000") => code("payout", action, { view, available });
  assert.equal(payoutCode(withdraw()), "ok");
  assert.equal(payoutCode(withdraw({ asset: ASSETS.USDC })), "ok");
  for (const [change, why] of [[{ chain: "eth" }, "another chain"], [{ confidential: false }, "the public balance"], [{ memo: "x" }, "a memo"],
    [{ asset: "nep141:other.near" }, "another asset"]] as const)
    assert.equal(payoutCode(withdraw(change)), "withdraw_not_allowed", why);
  assert.equal(payoutCode(withdraw({ recipient: "other.near" })), "payee_not_agreed");
  const memoed: Policy = { ...withdrawing, destinations: { mode: "only", list: [{ action: "withdraw", chain: "near", address: "payee.near", memo: "m" }] } };
  assert.equal(code("payout", withdraw(), { view: policyView(memoed, 11), available: "5000" }), "payee_not_agreed", "a destination with a memo isn't this payee");
  const except: Policy = { ...withdrawing, destinations: { mode: "except", list: [] } };
  assert.equal(code("payout", withdraw(), { view: policyView(except, 11), available: "5000" }), "payee_not_agreed", "only an only-mode policy agrees to anyone");
  assert.equal(payoutCode(withdraw(), "999"), "insufficient_balance");
  assert.equal(code("payout", withdraw(), { view, available: "5000", heldPayouts: [{ recipient: "payee.near", asset: ASSETS.wNEAR, amount: "1000" }] }), "duplicate_held_payout");
  for (const purpose of ["invoice", "approval"] as const) assert.equal(code(purpose, withdraw(), { view }), "transfer_not_allowed", purpose);
  const usdcOnly: Policy = { ...withdrawing, assets: [ASSETS.USDC] };
  assert.equal(code("payout", withdraw(), { view: policyView(usdcOnly, 11), available: "5000" }), "asset_not_allowed", "an asset outside the policy is refused before sending");
  assert.equal(code("payout", withdraw(), { view: policyView({ ...withdrawing, assets: "any" }, 11), available: "5000" }), "ok");
  for (const purpose of ["treasury", "autopilot"] as const) assert.equal(code(purpose, withdraw()), "withdraw_not_allowed", purpose);
});

test("an approval releasing a payee the policy no longer agrees to is refused; sends leave payees to the provider", () => {
  assert.equal(code("approval", pay("stranger.near")), "payee_not_agreed");
  for (const purpose of ["payout", "invoice"] as const) assert.equal(code(purpose, pay("stranger.near")), "ok", purpose);
  const except: Policy = { ...payout, destinations: { mode: "except", list: [{ action: "transfer", address: "forbidden.near", confidential: true }] } };
  assert.deepEqual([...agreedPayees(except)], []);
  assert.equal(code("approval", pay("other.near"), { view: policyView(except, 11) }), "payee_not_agreed");
  const mixed: Policy = { ...payout, destinations: { mode: "only", list: [
    { action: "transfer", address: "payee.near", confidential: true },
    { action: "transfer", address: "public.near", confidential: false },
  ] } };
  assert.deepEqual([...agreedPayees(mixed)], ["payee.near"]);
});

test("invoices and approvals need a policy that holds every payment for the owner; plain payouts don't", () => {
  const unheld = policyView({ ...payout, owner_approval: false }, 11);
  assert.equal(code("invoice", pay(), { view: unheld }), "owner_approval_required");
  assert.equal(code("approval", pay(), { view: unheld }), "owner_approval_required");
  assert.equal(code("payout", pay(), { view: unheld }), "ok");
});

test("a payout or invoice the wallet can't cover is refused before it goes to a vote", () => {
  for (const purpose of ["payout", "invoice"] as const) {
    assert.equal(code(purpose, pay("payee.near", USDC(100)), { available: USDC(100) }), "ok", purpose);
    assert.equal(code(purpose, pay("payee.near", USDC(1)), { available: "999999" }), "insufficient_balance", purpose);
    assert.equal(code(purpose, pay(), { available: "0" }), "insufficient_balance", purpose);
  }
});

test("a payout repeating a held payout's recipient, asset and amount is refused; other purposes aren't", () => {
  const heldPayouts = [{ recipient: "payee.near", asset: ASSETS.USDC, amount: USDC(1) }];
  assert.equal(code("payout", pay(), { heldPayouts }), "duplicate_held_payout");
  assert.equal(code("payout", pay("payee.near", USDC(2)), { heldPayouts }), "ok");
  assert.equal(code("invoice", pay()), "ok");
});

test("a plan's send is refused once anything it was previewed under has changed", () => {
  const leg = { type: "swap" as const, from: ASSETS.wNEAR, to: ASSETS.USDC, amount: NEAR(1), amountOut: USDC(2), minAmountOut: String(1_960_000), costBps: 200 };
  const plan = { id: "p", source: "rebalance", createdAt: new Date(NOW - 60_000).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString(),
    instruction: "", actions: [leg], agentId: process.env.AGENT_ID!, policyRevision: 11, policyDigest: mandateDigest(treasury),
    strategyDigest: strategyDigest(strategy), balances: {} } as unknown as Plan;
  const sending = (p: Partial<Plan> = {}, l: Partial<typeof leg> = {}) => ({ plan: { ...plan, ...p }, leg: { ...leg, ...l } });
  for (const purpose of ["treasury", "autopilot"] as const) {
    assert.equal(code(purpose, swap(), { plan: sending() }), "ok", purpose);
    assert.equal(code(purpose, swap(), { plan: sending({ expiresAt: new Date(NOW).toISOString() }) }), "plan_expired", purpose);
    assert.equal(code(purpose, swap(), { plan: sending({ agentId: "b".repeat(64) }) }), "plan_agent_changed", purpose);
    assert.equal(code(purpose, swap(), { plan: sending({ strategyDigest: "sha256:other" }) }), "strategy_changed", purpose);
    assert.equal(code(purpose, swap(), { plan: sending({ policyRevision: 10 }) }), "plan_policy_changed", purpose);
    assert.equal(code(purpose, swap(), { plan: sending({ policyDigest: "other" }) }), "plan_policy_changed", purpose);
    // 1 wNEAR at $2 with a floor of 1.9 USDC costs 500 bps, over the strategy's 250.
    assert.equal(code(purpose, swap(), { plan: sending({}, { minAmountOut: USDC(1.9) }) }), "swap_cost_exceeded", purpose);
  }
});

test("planned swaps need fresh finite valuations before shielding and before swapping", () => {
  const leg = { type: "swap" as const, from: ASSETS.wNEAR, to: ASSETS.USDC, amount: NEAR(1), amountOut: USDC(2), minAmountOut: USDC(2), costBps: 0 };
  const plan = { agentId: process.env.AGENT_ID!, expiresAt: new Date(NOW + 60_000).toISOString(),
    policyRevision: 11, policyDigest: mandateDigest(treasury), strategyDigest: strategyDigest(strategy) } as Plan;
  const actions: Action[] = [swap(), { method: "shield", request: { asset: ASSETS.wNEAR, amount: NEAR(1) } }];
  for (const purpose of ["treasury", "autopilot"] as const) {
    for (const action of actions) {
      for (const asset of [ASSETS.wNEAR, ASSETS.USDC]) {
        for (const change of [{ price: null }, { price: Infinity }, { price: -1 }, { price_updated_at: null },
          { price_expires_at: "invalid" }, { price_expires_at: new Date(NOW).toISOString() },
          { price_updated_at: new Date(NOW + 1).toISOString() }]) {
          const observed = tokens.map(token => token.asset_id === asset ? { ...token, ...change } : token);
          assert.equal(code(purpose, action, { plan: { plan, leg }, tokens: observed }), "valuation_unavailable");
        }
      }
    }
  }
});

test("automatic swaps require known cumulative plan value, while manual swaps and sweeps keep their scope", () => {
  const leg = { type: "swap" as const, from: ASSETS.wNEAR, to: ASSETS.USDC, amount: NEAR(1), amountOut: USDC(2), minAmountOut: USDC(2), costBps: 0 };
  const plan = { agentId: process.env.AGENT_ID!, expiresAt: new Date(NOW + 60_000).toISOString(),
    policyRevision: 11, policyDigest: mandateDigest(treasury), strategyDigest: strategyDigest(strategy) } as Plan;
  const planned = { plan, leg };
  const shield: Action = { method: "shield", request: { asset: ASSETS.wNEAR, amount: NEAR(1) } };
  for (const action of [swap(), shield]) {
    assert.equal(code("autopilot", action, { plan: planned, submittedSwapValues: [8] }), "ok");
    assert.equal(code("autopilot", action, { plan: planned, submittedSwapValues: [8.01] }), "autopilot_limit_exceeded");
    for (const value of [null, undefined, NaN, Infinity, -1])
      assert.equal(code("autopilot", action, { plan: planned, submittedSwapValues: [value] }), "valuation_unavailable");
    for (const unavailable of [null, undefined])
      assert.equal(code("autopilot", action, { plan: planned, submittedSwapValues: unavailable }), "valuation_unavailable");
    assert.equal(code("treasury", action, { plan: planned, submittedSwapValues: [100] }), "ok");
  }
  assert.equal(code("autopilot", swap()), "valuation_unavailable", "no plan cannot imply an unused ceiling");
  assert.equal(code("autopilot", shield, { submittedSwapValues: null }), "ok", "a sweep does not consume the swap ceiling");
});
