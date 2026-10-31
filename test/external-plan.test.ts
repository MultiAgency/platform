import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "../src/api.js";
import { ASSETS, treasuryPolicy } from "../src/policy.js";
import { prepareExternalPlan } from "../src/planning/external.js";
import { readOps } from "../src/ops.js";
import { loadPlan } from "../src/plans.js";
import { freshDirectory } from "./fixtures/harness.js";
freshDirectory("external-plan", { per: "test" });

const swaps = [{ from: ASSETS.USDC, to: ASSETS.wNEAR, amount: "1000000" }];
function provider() {
  let quotes = 0;
  process.env.AGENT_GRANT_TOKEN = "ngt_offline_fixture";
  api.forGrant = () => ({ swap: api.swap.bind(api) }) as never;
  api.getTokens = async () => Object.entries(ASSETS).map(([symbol, asset_id]) => ({ asset_id, symbol, decimals: symbol === "USDC" ? 6 : symbol === "ETH" ? 18 : 24, price: symbol === "USDC" ? 1 : symbol === "ETH" ? 2000 : 2, price_updated_at: new Date().toISOString(), price_expires_at: new Date(Date.now() + 60_000).toISOString() })) as never;
  api.getBalances = async (_id, { source } = {}) => ({ balances: [{ asset_id: ASSETS.USDC, balance_raw: source === "public" ? "0" : "10000000" }] }) as never;
  api.getPolicy = async () => ({ revision: 1, policy: treasuryPolicy }) as never;
  api.swap = async (_id, input) => {
    assert.equal(input.dry, true, "planning must never submit a money action");
    quotes++;
    const output = BigInt(input.amount) * 500000000000000000n;
    return { quote: { amount_out: output.toString(), min_amount_out: (output * 998n / 1000n).toString() } } as never;
  };
  return () => quotes;
}

test("external choices become quoted, policy/strategy-bound saved plans without sending", async () => {
  const quotes = provider();
  const plan = await prepareExternalPlan({ swaps });
  assert.equal(plan.source, "external");
  assert.equal(plan.actions.length, 1);
  assert.deepEqual(plan.actions[0], { type: "swap", ...swaps[0], amountOut: "500000000000000000000000", minAmountOut: "499000000000000000000000", costBps: 0 });
  assert.ok(plan.policyDigest); assert.ok(plan.strategyDigest);
  assert.deepEqual(loadPlan(plan.id), plan);
  assert.equal(quotes(), 1); assert.deepEqual(readOps(), []);
});

test("external plans reject invalid actions, forbidden outputs, infeasible totals and unsafe quotes", async () => {
  provider();
  for (const input of [{ swaps: [] }, { swaps: [{ ...swaps[0], amount: "-1" }] }, { swaps: [{ ...swaps[0], amount: "1.5" }] }, { swaps: [{ ...swaps[0], to: ASSETS.USDC }] }, { swaps, execute: true }, { swaps: [{ ...swaps[0], to: "https://arbitrary.test" }] }])
    await assert.rejects(prepareExternalPlan(input));
  api.getPolicy = async () => ({ revision: 1, policy: { ...treasuryPolicy, assets: [ASSETS.USDC] } }) as never;
  await assert.rejects(prepareExternalPlan({ swaps }), /policy/);
  provider();
  await assert.rejects(prepareExternalPlan({ swaps: [{ ...swaps[0], amount: "999999999999" }] }));
  await assert.rejects(prepareExternalPlan({ swaps: [{ ...swaps[0], amount: "6000000" }, { ...swaps[0], amount: "6000000" }] }), /remaining balance/);
  await assert.rejects(prepareExternalPlan({ swaps: [{ ...swaps[0], minAmountOut: "999999999999999999999999" }] }), /floor/);
  api.swap = async () => ({ quote: { amount_out: "500000000000000000000000", min_amount_out: "1" } }) as never;
  await assert.rejects(prepareExternalPlan({ swaps }), /cost/);
  assert.deepEqual(readOps(), []);
});

test("policy changes during external quoting refuse saving the plan", async () => {
  provider();
  let reads = 0;
  api.getPolicy = async () => ({ revision: ++reads, policy: treasuryPolicy }) as never;
  await assert.rejects(prepareExternalPlan({ swaps }), /policy changed/);
  assert.deepEqual(readOps(), []);
});

test("external plans preserve order and stricter floors, never lower provider floors", async () => {
  provider();
  const chosen = [
    { ...swaps[0], amount: "2000000", minAmountOut: "999000000000000000000000" },
    { ...swaps[0], minAmountOut: "1" },
  ];
  const plan = await prepareExternalPlan({ swaps: chosen });
  assert.deepEqual(plan.actions.map(action => action.type === "swap" && action.amount), ["2000000", "1000000"]);
  assert.deepEqual(plan.actions.map(action => action.type === "swap" && action.minAmountOut),
    [chosen[0]!.minAmountOut, "499000000000000000000000"]);
  assert.equal(Date.parse(plan.expiresAt) - Date.parse(plan.createdAt), 300_000);
});

test("a later failed quote saves no partial plan; required plan storage failure refuses", async () => {
  provider();
  const { existsSync, writeFileSync } = await import("node:fs");
  const quote = api.swap; let calls = 0;
  api.swap = (async (...args: Parameters<typeof api.swap>) => { if (++calls === 2) throw new Error("quote unavailable"); return quote(...args); }) as typeof api.swap;
  await assert.rejects(prepareExternalPlan({ swaps: [...swaps, ...swaps] }), /quote unavailable/);
  assert.equal(existsSync(".plans"), false);
  provider(); writeFileSync(".plans", "blocked storage");
  await assert.rejects(prepareExternalPlan({ swaps }));
  assert.deepEqual(readOps(), []);
});

test("changed balances and expired valuations refuse external preparation", async () => {
  provider(); let confidentialReads = 0;
  api.getBalances = async (_id, { source } = {}) => ({ balances: [{ asset_id: ASSETS.USDC,
    balance_raw: source === "public" ? "0" : ++confidentialReads === 1 ? "10000000" : "9000000" }] }) as never;
  await assert.rejects(prepareExternalPlan({ swaps }), /balance/);
  provider(); const tokens = api.getTokens;
  api.getTokens = async (...args) => (await tokens(...args)).map(token => ({ ...token, price_expires_at: new Date(0).toISOString() }));
  await assert.rejects(prepareExternalPlan({ swaps }), /fresh price/);
  assert.deepEqual(readOps(), []);
});

test("an external plan with a leg the provider warns about is refused before it is saved", async () => {
  provider();
  api.swap = async (_id, input) => {
    const output = BigInt(input.amount) * 500000000000000000n;
    return { quote: { amount_out: output.toString(), min_amount_out: (output * 998n / 1000n).toString() }, warnings: [{ code: "policy_asset_denied", detail: "d" }] } as never;
  };
  await assert.rejects(prepareExternalPlan({ swaps }), /provider's dry run warned \(policy_asset_denied\)/);
  assert.deepEqual(readOps(), []);
});
