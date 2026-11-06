import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { authorityFixture, balanceView, fixtureGrant, policyView, quoteAt, timedPrices, wholeTokens } from "./fixtures/authority.js";
import { freshDirectory, offline } from "./fixtures/harness.js";
import { api } from "../src/api.js";
import { saveSettings, settings, tick } from "../src/autopilot.js";
import { ticks } from "../src/evidence.js";
import { stopSending } from "../src/lock.js";
import { readOps } from "../src/ops.js";
import { ASSETS, treasuryPolicy } from "../src/policy.js";
import { loadStrategy } from "../src/strategy.js";
import { strategyLabelSuffix } from "../src/strategy-digest.js";

// Its own file, so its own process: once a process stops sending, it never sends again.
freshDirectory("shutdown");

test("a stop during an autopilot run ends it after the swap in flight, and its record says so, not that it was skipped", async () => {
  process.env.AGENT_GRANT_TOKEN = "ngt_test";
  // 100 USDC and nothing else: the rebalance plans two swaps.
  const book: Record<string, { public: bigint; confidential: bigint }> =
    Object.fromEntries(Object.values(ASSETS).map((asset) => [asset, { public: 0n, confidential: 0n }]));
  book[ASSETS.USDC]!.confidential = 100n;
  const tokens = wholeTokens(), sends: string[] = [];
  offline();
  const authority = authorityFixture("treasury");
  mock.method(api, "getAgent", authority.getAgent);
  mock.method(api, "getWallet", authority.getWallet);
  mock.method(api, "getHistory", authority.getHistory);
  mock.method(api, "getPolicy", async () => policyView({ ...treasuryPolicy, budget: { daily_usd: "1000", weekly_usd: "1000", monthly_usd: "1000" } }, 1));
  mock.method(api, "getTokens", async () => timedPrices(tokens));
  mock.method(api, "getBalances", async (_id: string, { source }: { source: "public" | "confidential" }) => balanceView(source,
    Object.entries(book).map(([asset_id, balances]) => ({ asset_id, balance_raw: String(balances[source]) }))));
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, status: "SUCCESS" }));
  mock.method(api, "listGrants", async () => [{ ...fixtureGrant(`treasury:${strategyLabelSuffix(loadStrategy())}`), grant_id: "g" }]);
  mock.method(api, "forGrant", () => ({
    swap: async (_id: string, request: { dry?: boolean; origin_asset: string; destination_asset: string; amount: string }) => {
      if (request.dry) return { quote: quoteAt(tokens, request) };
      sends.push(request.destination_asset);
      book[request.origin_asset]!.confidential -= BigInt(request.amount);
      book[request.destination_asset]!.confidential += BigInt(quoteAt(tokens, request).amount_out);
      // The server is told to stop while this first swap is in flight.
      stopSending();
      return { correlation_id: `op_${sends.length}` };
    },
  }));
  saveSettings({ ...settings(), maxUsd: 100 });

  const report = await tick("schedule");
  assert.equal(sends.length, 1, "the swap in flight completes; the next isn't sent");
  assert.doesNotMatch(report, /another money action/);
  assert.match(report, /step 1: SUCCESS/);
  assert.match(report, /stopping/);
  assert.equal(ticks().ticks[0]?.end?.outcome, report);
  assert.deepEqual(readOps().map((op) => op.status), ["SUCCESS"], "one operation, resolved; nothing left unresolved");
});

test("once stopping, a tick sends nothing and says why", async () => {
  const report = await tick("schedule");
  assert.match(report, /^Skipped: This agent's server is stopping/);
  assert.deepEqual(readOps(), [], "nothing recorded");
});
