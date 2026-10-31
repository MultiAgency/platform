import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "../src/api.js";
import { stewardTools } from "../src/llm.js";
import { ASSETS, treasuryPolicy } from "../src/policy.js";
import type { PlannedAction } from "../src/plans.js";
import { loadStrategy } from "../src/strategy.js";
import { freshDirectory } from "./fixtures/harness.js";
freshDirectory("steward-tools", { per: "test" });

function provider(warnings: { code: string; detail: string }[]) {
  process.env.AGENT_GRANT_TOKEN = "ngt_offline_fixture";
  api.forGrant = () => ({ swap: api.swap.bind(api) }) as never;
  api.getTokens = async () => Object.entries(ASSETS).map(([symbol, asset_id]) => ({ asset_id, symbol, decimals: symbol === "USDC" ? 6 : symbol === "ETH" ? 18 : 24, price: symbol === "USDC" ? 1 : symbol === "ETH" ? 2000 : 2, price_updated_at: new Date().toISOString(), price_expires_at: new Date(Date.now() + 60_000).toISOString() })) as never;
  api.getBalances = async (_id, { source } = {}) => ({ balances: [{ asset_id: ASSETS.USDC, balance_raw: source === "public" ? "0" : "10000000" }] }) as never;
  api.getPolicy = async () => ({ revision: 1, policy: treasuryPolicy }) as never;
  api.swap = async (_id, input) => {
    assert.equal(input.dry, true, "the steward must never submit a money action");
    const output = BigInt(input.amount) * 500000000000000000n;
    return { quote: { amount_out: output.toString(), min_amount_out: (output * 998n / 1000n).toString() }, warnings } as never;
  };
}
const swap = (plan: PlannedAction[]) => stewardTools(plan, loadStrategy()).find((t) => t.spec.function.name === "swap")!;

test("the steward doesn't propose a swap the provider warns about", async () => {
  provider([{ code: "policy_asset_denied", detail: "d" }]);
  const plan: PlannedAction[] = [];
  assert.match(await swap(plan).run({ from: "USDC", to: "wNEAR", amount: "1" }), /^NOT PROPOSED: .*policy_asset_denied/);
  assert.deepEqual(plan, []);
});

test("a clean swap is proposed with exactly the plan's swap fields", async () => {
  provider([]);
  const plan: PlannedAction[] = [];
  assert.match(await swap(plan).run({ from: "USDC", to: "wNEAR", amount: "1" }), /^PROPOSED as step 1/);
  assert.deepEqual(plan, [{ type: "swap", from: ASSETS.USDC, to: ASSETS.wNEAR, amount: "1000000",
    amountOut: "500000000000000000000000", minAmountOut: "499000000000000000000000", costBps: 0 }]);
});
