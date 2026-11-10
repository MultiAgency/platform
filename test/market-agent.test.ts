import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { test } from "node:test";
import { HostedAgents, selfServiceRequest, setupRequest } from "../src/gateway/hosted-agents.js";
import { checkHostedCreation } from "../src/hosted-binding.js";
import { newPaymentKey, paymentKey } from "../src/market/payment-key.js";
import { ownerAction } from "../src/contract/inputs.js";
import { ownerRequests } from "../src/owner-requests.js";
import { ASSETS, marketPolicy } from "../src/policy.js";

/**
 * A market agent (docs/market.md): set up by an app only, with a payment key written into its settings file at
 * reservation, so the policy it is created with names that key's account as its one withdrawal destination.
 */

const owner = { type: "near" as const, account_id: "alice.near", public_key: "ed25519:11111111111111111111111111111111" };
const scope = { deployment: "covenant", organization: "acme" };

test("only an app sets up a market agent: self-service refuses the area", () => {
  assert.equal(setupRequest.safeParse({ owner: "alice.near", kind: "wallet", area: "market" }).success, true);
  assert.equal(selfServiceRequest.safeParse({ owner: "alice.near", kind: "wallet", area: "market" }).success, false);
  assert.equal(selfServiceRequest.safeParse({ owner: "alice.near", kind: "wallet", area: "payables" }).success, true);
});

test("a market agent's reservation writes its payment key once, and no other area gets one", t => {
  const dir = mkdtempSync(join(tmpdir(), "hosted-market-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hosted = new HostedAgents(dir, []);
  const market = hosted.reserve({ owner: "alice.near", kind: "wallet", area: "market" }, scope);
  const settings = () => parseEnv(readFileSync(market.envFile, "utf8"));
  const key = settings().MARKET_PAYMENT_KEY;
  assert.match(key ?? "", /^ed25519:/);
  // Reserving again finds the agent and never replaces the key: funds or an authorization may sit on it.
  assert.equal(hosted.reserve({ owner: "alice.near", kind: "wallet", area: "market" }, scope).name, market.name);
  assert.equal(settings().MARKET_PAYMENT_KEY, key);
  const payables = hosted.reserve({ owner: "alice.near", kind: "wallet", area: "payables" }, scope);
  assert.equal(parseEnv(readFileSync(payables.envFile, "utf8")).MARKET_PAYMENT_KEY, undefined);
  assert.notEqual(payables.name, market.name);
});

test("a market agent is created with the market policy naming its own payment key, and nothing else", () => {
  const before = process.env.MARKET_PAYMENT_KEY;
  process.env.MARKET_PAYMENT_KEY = newPaymentKey();
  try {
    const request = ownerRequests.agent_create(owner, "market");
    const account = paymentKey().account;
    assert.deepEqual(request.policy, marketPolicy(account));
    assert.deepEqual(request.policy.actions, ["withdraw"]);
    assert.deepEqual(request.policy.destinations, { mode: "only", list: [{ action: "withdraw", chain: "near", address: account, memo: null }] });
    assert.deepEqual(request.policy.assets, [ASSETS.USDC, ASSETS.wNEAR]);
  } finally {
    if (before === undefined) delete process.env.MARKET_PAYMENT_KEY; else process.env.MARKET_PAYMENT_KEY = before;
  }
});

test("an agent without a payment key can't be created as a market agent", () => {
  assert.throws(() => paymentKey({}), /no payment key/);
});

test("a hosted market agent can only be created for the market role, and a market role only by a market agent", () => {
  const env = { HOSTED_OWNER: "alice.near", HOSTED_OWNER_KIND: "wallet", DASHBOARD_AREA: "market" };
  assert.doesNotThrow(() => checkHostedCreation(owner, "wallet", "market", env));
  assert.throws(() => checkHostedCreation(owner, "wallet", "treasury", env));
  assert.throws(() => checkHostedCreation(owner, "wallet", "payout", env));
  assert.throws(() => checkHostedCreation(owner, "wallet", "market", { ...env, DASHBOARD_AREA: "payables" }));
  assert.equal(ownerAction.safeParse({ type: "agent_create", role: "market" }).success, true);
  assert.equal(ownerAction.safeParse({ type: "grant_issue", label: "market" }).success, true);
});
