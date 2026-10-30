import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { api } from "../src/api.js";
import { pay } from "../src/agent.js";
import { prepare } from "../src/owner-intents.js";
import { policyChange, policyRequest } from "../src/owner-requests.js";
import { mandateDigest } from "../src/mandate.js";
import { readOps, blocksDispatch } from "../src/ops.js";
import { ASSETS, payoutPolicy } from "../src/policy.js";
import { authorityFixture, policyView } from "./fixtures/authority.js";
import { freshDirectory, offline } from "./fixtures/harness.js";
import { createRouterClient } from "@orpc/server";
import { router } from "../src/router.js";

freshDirectory("policy-review");
const original = payoutPolicy(["payee.near"]);
const expected = { revision: 1, digest: mandateDigest(original) };
const request = { recipient: "payee.near", asset: ASSETS.USDC, amount: "1000000", confidential: true };
let current = original;
let revision = 1;
let sends: unknown[];
beforeEach(() => {
  offline();
  process.env.EXECUTOR = "on";
  process.env.AGENT_GRANT_TOKEN = "ngt_review_fixture";
  current = structuredClone(original); revision = 1; sends = [];
  for (const [name, value] of Object.entries(authorityFixture())) mock.method(api, name as keyof typeof api, value as never);
  mock.method(api, "getPolicy", async () => policyView(current, revision));
  mock.method(api, "forGrant", () => ({ transfer: async (_id: string, terms: unknown) => {
    sends.push(terms); return { correlation_id: "fixture-payment" };
  } }) as never);
  mock.method(api, "getStatus", async () => ({ correlation_id: "fixture-payment", status: "PENDING_APPROVAL" }) as never);
});
afterEach(() => mock.restoreAll());

test("policy preparation rejects a stale revision even when policy content is unchanged", async () => {
  revision = 2;
  await assert.rejects(policyRequest({ max_actions_per_hour: 5 }, expected), /policy.*changed/i);
});

test("policy preparation rejects changed safeguards even at the same revision", async () => {
  current = { ...original, owner_approval: false };
  await assert.rejects(policyRequest({ max_actions_per_hour: 5 }, expected), /policy.*changed/i);
});

test("matching policy preparation retains provider revision binding and untouched safeguards", async () => {
  const result = await policyRequest({ max_actions_per_hour: 5 }, expected);
  assert.equal(result.expected_revision, 1);
  assert.equal(result.policy.owner_approval, true);
  assert.equal(result.policy.max_actions_per_hour, 5);
});

test("stale owner review never asks the provider to generate a signing payload", async () => {
  revision = 2;
  const generate = mock.method(api, "generateIntent", async () => { throw new Error("must not generate"); });
  await assert.rejects(prepare({ type: "policy_update", changes: { max_actions_per_hour: 5 }, expectedPolicy: expected }, "wallet"), /policy.*changed/i);
  assert.equal(generate.mock.callCount(), 0);
});

test("matching owner review reaches generation with the reviewed revision and exact requested change", async () => {
  const generate = mock.method(api, "generateIntent", async (request: { type: string; expected_revision?: number; policy?: typeof original }) => {
    assert.equal(request.type, "policy_update");
    assert.equal(request.expected_revision, expected.revision);
    assert.equal(request.policy?.max_actions_per_hour, 5);
    assert.equal(request.policy?.owner_approval, true);
    throw new Error("generation reached");
  });
  await assert.rejects(prepare({ type: "policy_update", changes: { max_actions_per_hour: 5 }, expectedPolicy: expected }, "wallet"), /^Error: generation reached$/);
  assert.equal(generate.mock.callCount(), 1);
});

test("a prepared edit names the policy in force and the one requested, including fields derived from the change", async () => {
  mock.method(api, "generateIntent", async (request: { type: string }) => ({ type: request.type, correlation_id: "edit-1", expires_at: new Date(Date.now() + 60_000).toISOString(),
    preview: { summary: "Change the policy" }, intent: { standard: "nep366", payload: { receiverId: "outlayer.near", actions: [] } },
    signer: { type: "near", account_id: "owner.near", public_key: "ed25519:k" } }) as never);
  const prepared = await prepare({ type: "policy_update", changes: { destinations: [] }, expectedPolicy: expected }, "wallet");
  assert.deepEqual(prepared.policy?.current, original);
  assert.deepEqual(prepared.policy?.requested, { ...original, actions: [], destinations: { mode: "only", list: [] } },
    "removing the last payee also turns transfers off, and the record says so");
});

test("a payout agent's first payee changes only its destinations: it was created with transfers on", async () => {
  current = payoutPolicy([]);
  const { request, current: before } = await policyChange({ destinations: [{ address: "payee.near", confidential: true }] }, { revision: 1, digest: mandateDigest(current) });
  assert.deepEqual(before.actions, ["transfer"]);
  assert.deepEqual(request.policy.actions, ["transfer"]);
  assert.deepEqual(request.policy.destinations.list, [{ action: "transfer", address: "payee.near", confidential: true }]);
});

test("withdrawal payees switch withdrawals on and off; withdrawal destinations the platform doesn't manage are kept", async () => {
  current = payoutPolicy(["payee.near"]);
  const reviewed = () => ({ revision: 1, digest: mandateDigest(current) });
  const added = (await policyChange({ withdrawals: [{ address: "worker.near" }] }, reviewed())).request.policy;
  assert.deepEqual(added.actions, ["transfer", "withdraw"]);
  assert.deepEqual(added.destinations.list, [
    { action: "transfer", address: "payee.near", confidential: true },
    { action: "withdraw", chain: "near", address: "worker.near", memo: null },
  ]);
  current = { ...added, destinations: { mode: "only", list: [...added.destinations.list, { action: "withdraw", chain: "base", address: "0xabc", memo: null }] } };
  const kept = (await policyChange({ withdrawals: [] }, reviewed())).request.policy;
  assert.deepEqual(kept.destinations.list, [
    { action: "withdraw", chain: "base", address: "0xabc", memo: null },
    { action: "transfer", address: "payee.near", confidential: true },
  ], "the platform's own withdrawal payees are removed; another chain's is kept");
  assert.deepEqual(kept.actions, ["transfer", "withdraw"], "withdrawals stay on while any withdrawal destination remains");
  current = { ...added };
  const removed = (await policyChange({ withdrawals: [] }, reviewed())).request.policy;
  assert.deepEqual(removed.actions, ["transfer"], "removing the last withdrawal payee turns withdrawals off");
  const untouched = (await policyChange({ budget: { daily_usd: "10", weekly_usd: null, monthly_usd: null } }, reviewed())).request.policy;
  assert.deepEqual(untouched.destinations.list, added.destinations.list, "an edit that doesn't name withdrawals keeps them");
});

test("an edit that doesn't name withdrawals leaves them exactly as they are, on or off", async () => {
  const budget = { budget: { daily_usd: "10", weekly_usd: null, monthly_usd: null } };
  const payees = payoutPolicy(["payee.near"]);
  for (const [actions, destinations] of [
    [["transfer"], [{ action: "withdraw", chain: "near", address: "worker.near", memo: null }]],
    [["transfer"], [{ action: "withdraw", chain: "base", address: "0xabc", memo: null }]],
    [["transfer", "withdraw"], []],
  ] as const) {
    current = { ...payees, actions: [...actions], destinations: { mode: "only", list: [...payees.destinations.list, ...destinations] } };
    const edited = (await policyChange(budget, { revision: 1, digest: mandateDigest(current) })).request.policy;
    assert.deepEqual(edited.actions, [...actions], JSON.stringify(destinations));
  }
});

test("a field sent as undefined stays as it is in force, never dropped from the requested policy", async () => {
  const result = await policyRequest({ owner_approval: undefined, max_actions_per_hour: 5 }, expected);
  assert.equal(result.policy.owner_approval, original.owner_approval);
  assert.equal(result.policy.max_actions_per_hour, 5);
});

test("payment dispatch refuses a changed reviewed policy without sending or leaving unresolved work", async () => {
  current = { ...original, owner_approval: false };
  const result = await pay(request, expected);
  assert.deepEqual(result, { outcome: "refused", code: "reviewed_policy_changed" });
  assert.equal(sends.length, 0);
  assert.equal(readOps().length, 1);
  assert.equal(readOps()[0]?.refused, "reviewed_policy_changed");
  assert.equal(readOps().some(blocksDispatch), false);
});

test("payment dispatch checks revision as well as digest", async () => {
  revision = 2;
  assert.deepEqual(await pay(request, expected), { outcome: "refused", code: "reviewed_policy_changed" });
  assert.equal(sends.length, 0);
});

test("matching reviewed payment sends exact terms once without passing review metadata to provider", async () => {
  const result = await pay(request, expected);
  assert.equal(result.outcome, "settled");
  assert.deepEqual(sends, [request]);
  assert.equal(readOps()[0]?.policyDigest, expected.digest);
});

test("dashboard routes reject absent or malformed review evidence before provider reads", async () => {
  const client = createRouterClient(router);
  const read = mock.method(api, "getPolicy", async () => { throw new Error("must not read"); });
  for (const expectedPolicy of [undefined, { revision: 1, digest: "invalid" }, { revision: -1, digest: expected.digest }]) {
    await assert.rejects(client.pay({ ...request, expectedPolicy } as never), { code: "BAD_REQUEST" });
    await assert.rejects(client.owner.prepare({ action: { type: "policy_update", changes: {}, expectedPolicy }, signer: "wallet" } as never), { code: "BAD_REQUEST" });
  }
  assert.equal(read.mock.callCount(), 0);
  assert.equal(sends.length, 0);
});

test("dashboard payment route carries the reviewed policy to dispatch", async () => {
  revision = 2;
  assert.deepEqual(await createRouterClient(router).pay({ ...request, expectedPolicy: expected }), { outcome: "refused", code: "reviewed_policy_changed" });
  assert.equal(sends.length, 0);
});

test("missing current policy refuses a reviewed payment", async () => {
  mock.method(api, "getPolicy", async () => ({ ...policyView(original), policy: null, revision: null }));
  assert.deepEqual(await pay(request, expected), { outcome: "refused", code: "reviewed_policy_changed" });
  assert.equal(sends.length, 0);
  assert.equal(readOps().some(blocksDispatch), false);
});
