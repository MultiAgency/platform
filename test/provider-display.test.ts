import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { AgentApiError } from "@near-intents-agent-api/sdk";
import { createRouterClient, ORPCError } from "@orpc/server";
import { api } from "../src/api.js";
import { router } from "../src/router.js";
import { paymentStatus } from "../src/payouts.js";
import { ASSETS, payoutPolicy } from "../src/policy.js";
import { authorityFixture, policyView } from "./fixtures/authority.js";
import { freshDirectory, offline } from "./fixtures/harness.js";
import { pay } from "../src/agent.js";
import { readOps, blocksDispatch } from "../src/ops.js";
import { allHoldings } from "../src/holdings.js";

freshDirectory("provider-display");
const client = createRouterClient(router);
beforeEach(() => {
  offline();
  process.env.AGENT_GRANT_TOKEN = "ngt_display_fixture";
  for (const [name, value] of Object.entries(authorityFixture())) mock.method(api, name as keyof typeof api, value as never);
  mock.method(api, "getPolicy", async () => policyView(payoutPolicy(["payee.near"])));
});
afterEach(() => mock.restoreAll());

test("dashboard keeps balances when a managed asset lacks a price", async () => {
  mock.method(api, "getTokens", async () => Object.values(ASSETS).map(asset_id => ({ asset_id, symbol: "fixture", decimals: 6, price: null })) as never);
  const result = await client.overview();
  assert.equal(result.policy.usage.budget.weekly.spent_usd, "0.000000", "an uncapped window reads as clients on earlier SDKs expect");
  const usdc = result.book.find(h => h.asset === ASSETS.USDC)!;
  assert.equal(usdc.confidential, 1000000000n);
  assert.equal(usdc.usd, null);
  await assert.rejects(allHoldings(), /No fresh price/, "execution holdings still refuse a missing price");
});

test("dashboard excludes expired prices and preserves their timestamps", async () => {
  mock.method(api, "getTokens", async () => Object.values(ASSETS).map(asset_id => ({ asset_id, symbol: "fixture", decimals: 6, price: 1,
    price_updated_at: "2020-01-01T00:00:00Z", price_expires_at: "2020-01-01T00:01:00Z" })) as never);
  const usdc = (await client.overview()).book.find(h => h.asset === ASSETS.USDC)!;
  assert.equal(usdc.usd, null);
  assert.equal((usdc as unknown as Record<string, unknown>).priceUpdatedAt, "2020-01-01T00:00:00Z");
});

test("RPC errors retain exact provider codes and allowlisted budget or retry metadata", async () => {
  for (const { status, code, method, call, meta, expected } of [
    { status: 403, code: "spend_budget_exceeded", method: "getPolicy" as const, call: () => client.overview(),
      meta: { budget_remaining_usd: "0.000001", available_at: "2030-01-01T00:00:00Z", token: "secret" },
      expected: { code: "spend_budget_exceeded", availableAt: "2030-01-01T00:00:00Z", budgetRemainingUsd: "0.000001" } },
    { status: 429, code: "policy_change_throttled", method: "getPolicyHistory" as const, call: () => client.policyHistory(),
      meta: { retryable: true, available_at: "2030-01-01T00:00:00Z", token: "secret" },
      expected: { code: "policy_change_throttled", availableAt: "2030-01-01T00:00:00Z" } },
  ]) {
    const read = mock.method(api, method, async () => { throw new AgentApiError(status,
      { errors: [{ status: String(status), code, title: "Provider refusal", meta }] } as never); });
    try {
      await assert.rejects(call, (error: unknown) => {
        assert.ok(error instanceof ORPCError, code);
        assert.deepEqual(error.data, { kind: "provider", ...expected }, code);
        return true;
      });
      assert.equal(read.mock.callCount(), 1, `${code} must come from the selected provider read`);
    } finally { read.mock.restore(); }
  }
});

test("payment status exposes provider-reported transaction and refund evidence only", async () => {
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, type: "transfer", agent_id: process.env.AGENT_ID,
    status: "REFUNDED", details: { tx_hash: "source-hash", destination_tx_hash: "destination-hash", refund_tx_hash: "refund-hash",
      refund_to: "agent.near", refunded_amount: "12345678901234567890", token: "secret", txHash: "wrong-field" } }) as never);
  const result = await paymentStatus("op_fixture");
  assert.deepEqual((result as unknown as { evidence: unknown }).evidence, { txHash: "source-hash", destinationTxHash: "destination-hash",
    refundTxHash: "refund-hash", refundTo: "agent.near", refundedAmount: "12345678901234567890" });
});

test("a proven payment refusal keeps budget facts without changing its outcome", async () => {
  process.env.EXECUTOR = "on";
  const meta = { retryable: false, budget_remaining_usd: "0.000001", available_at: "2030-01-01T00:00:00Z", secret: "omitted" };
  mock.method(api, "forGrant", () => ({ transfer: async () => { throw new AgentApiError(403,
    { errors: [{ status: "403", code: "spend_budget_exceeded", title: "Budget exceeded", meta }] } as never); } }) as never);
  assert.deepEqual(await pay({ recipient: "payee.near", asset: ASSETS.USDC, amount: "1000000", confidential: true }), {
    outcome: "refused", code: "spend_budget_exceeded", details: { availableAt: meta.available_at, budgetRemainingUsd: meta.budget_remaining_usd },
  });
  assert.equal(readOps().some(blocksDispatch), false);
  assert.equal(readOps()[0]?.refused, "spend_budget_exceeded");
});

test("metadata on an ambiguous error cannot turn it into a refusal", async () => {
  process.env.EXECUTOR = "on";
  mock.method(api, "forGrant", () => ({ transfer: async () => { throw new AgentApiError(503,
    { errors: [{ status: "503", code: "internal_error", title: "Unknown outcome", meta: { retryable: true, available_at: "2030-01-01T00:00:00Z" } }] } as never); } }) as never);
  await assert.rejects(pay({ recipient: "payee.near", asset: ASSETS.USDC, amount: "1000000", confidential: true }));
  assert.equal(readOps().some(blocksDispatch), true);
});
