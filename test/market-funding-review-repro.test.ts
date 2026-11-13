/** Regression from the funding-only safety review: absent runtime owner kind must fail closed. */
import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { generateKey, parseKey } from "near-kit";
import { market } from "./e2e/market.mjs";
import { fundingContextFixture } from "./fixtures/funding-context.js";
import { freshDirectory } from "./fixtures/harness.js";
const sim = await market({ agents: { writer: { amount: "10000", windowSeconds: 600, outcome: "complete", result: "unused" } } });
const secret = generateKey().secretKey;
const account = Buffer.from(parseKey(secret).publicKey.data).toString("hex");
Object.assign(process.env, { MARKET_URL: sim.url, NEAR_RPC_URL: sim.rpc, MARKET_PAYMENT_KEY: secret,
  AGENT_GRANT_TOKEN: "ngt_fixture", TREASURY_ACCOUNT: "fixture-dao.near" });
delete process.env.HOSTED_OWNER_KIND;
const { api } = await import("../src/api.js");
const { ASSETS, marketPolicy } = await import("../src/policy.js");
const { authorityFixture, fixtureGrant, policyView, timedPrices } = await import("./fixtures/authority.js");
const { fundMarketOnly, quoteHire } = await import("../src/market/hire.js");
const { fundingProof } = await import("../src/market/funding-proof.js");
freshDirectory("funding-review-repro");
after(() => sim.close());
test("review: DAO settings without gateway-injected owner kind must not authorize the wallet-only CLI path", async () => {
  for (const [name, method] of Object.entries(authorityFixture())) mock.method(api, name as keyof typeof api, method as never);
  mock.method(api, "listGrants", async () => [fixtureGrant("market")]);
  mock.method(api, "getPolicy", async () => policyView(marketPolicy(account)));
  mock.method(api, "getTokens", async () => timedPrices([{ asset_id: ASSETS.USDC, symbol: "USDC", decimals: 6, price: 1 }]));
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, type: "withdraw", status: "SUCCESS",
    details: { destination_tx_hash: "2".repeat(44), amount_out: "10000" } }));
  mock.method(fundingProof, "verify", async (input: { destinationTxHash?: string | null; recipient: string; asset: string; amount: string }) => ({ ...input, destinationTxHash: input.destinationTxHash!, blockHeight: sim.chain.height.toString() }));
  mock.method(api, "forGrant", () => ({ withdraw: async (_id: string, request: { recipient: string; amount: string }) => {
    sim.fund(request.recipient, request.amount); return { correlation_id: "op_review" };
  } }));
  sim.register(account); sim.fund(account, "0");
  const brief = "Owner-reviewed funding observation, no hire";
  const approved = await quoteHire({ handle: "writer", brief });
  const context = fundingContextFixture(secret, { owner: "fixture-dao.near", kind: "dao" });
  await assert.rejects(fundMarketOnly("owner:fixture", { requestId: "review-dao", brief, approved }, Date.now() + 60_000, context), /wallet owners only/);
});
