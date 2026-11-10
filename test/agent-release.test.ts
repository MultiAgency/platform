import assert from "node:assert/strict";
import { beforeEach, test, type TestContext } from "node:test";
import { writeFileSync, readFileSync } from "node:fs";
import { api } from "../src/api.js";
import { dispatch } from "../src/agent.js";
import { acquireMoneyLock } from "../src/lock.js";
import { prepare } from "../src/owner-intents.js";
import { prepareRelease } from "../src/agent-release.js";
import { record, readOps } from "../src/ops.js";
import { ASSETS } from "../src/policy.js";
import { freshDirectory } from "./fixtures/harness.js";
import { walletIntent, walletSigner } from "./fixtures/wallet-signature.js";
freshDirectory("agent-release");
beforeEach(() => { delete process.env.DASHBOARD_AREA; delete process.env.EXECUTOR; writeFileSync(".env", ""); });
const input = () => ({ agentId: process.env.AGENT_ID!, owner: "alice.near" });
function evidence(t: TestContext) {
  t.mock.method(api, "getAgent", async () => ({ id: process.env.AGENT_ID, wallet: { wallet_id: "fixture-wallet", near_account_id: "fixture.near" }, status: "ARCHIVED", owner: { type: "near", account_id: "alice.near" } }) as never);
  t.mock.method(api, "getPolicy", async () => ({ wallet_id: "fixture-wallet", policy: { frozen: true } }) as never);
  t.mock.method(api, "getBalances", async (_id: string, query: { source?: string }) => ({ near_account_id: "fixture.near", source: query.source, balances: [] }) as never);
}
test("release refuses unknown or held operations, leaves state intact, and makes no provider submission", async t => {
  evidence(t);
  record({ at: new Date().toISOString(), idempotencyKey: "unresolved", kind: "payout", method: "transfer", request: {} });
  record({ idempotencyKey: "unresolved", correlation_id: "op", status: "UNKNOWN" });
  assert.equal((await prepareRelease(input())).state, "refused");
  assert.equal(readFileSync(".env", "utf8"), "");
  record({ idempotencyKey: "unresolved", correlation_id: "op", status: "PENDING_APPROVAL" });
  assert.deepEqual(await prepareRelease(input()), { state: "refused", reason: "held", balances: [] });
});
test("release needs current archived, frozen ownership and refuses balances unless explicitly allowed", async t => {
  evidence(t);
  t.mock.method(api, "getAgent", async () => ({ id: process.env.AGENT_ID, wallet: { wallet_id: "fixture-wallet", near_account_id: "fixture.near" }, status: "ACTIVE", owner: { type: "near", account_id: "alice.near" } }) as never);
  assert.equal((await prepareRelease(input()) as { reason: string }).reason, "not_archived");
  t.mock.method(api, "getAgent", async () => ({ id: process.env.AGENT_ID, wallet: { wallet_id: "fixture-wallet", near_account_id: "fixture.near" }, status: "ARCHIVED", owner: { type: "near", account_id: "alice.near" } }) as never);
  t.mock.method(api, "getPolicy", async () => ({ wallet_id: "fixture-wallet", policy: { frozen: false } }) as never);
  assert.equal((await prepareRelease(input()) as { reason: string }).reason, "not_frozen");
  t.mock.method(api, "getPolicy", async () => ({ wallet_id: "fixture-wallet", policy: { frozen: true } }) as never);
  t.mock.method(api, "getBalances", async (_id: string, query: { source?: string }) => ({ near_account_id: "fixture.near", source: query.source, balances: [{ asset_id: ASSETS.USDC, balance_raw: "1" }] }) as never);
  const refused = await prepareRelease(input());
  assert.equal(refused.state, "refused");
  if (refused.state === "refused") { assert.equal(refused.reason, "balance"); assert.equal(refused.balances.length, 2); }
  assert.equal((await prepareRelease({ ...input(), allowBalance: true })).state, "prepared");
});
test("a durable marker refuses dispatch and owner actions before recording or provider calls, and retry preserves its time", async t => {
  evidence(t);
  const prepared = await prepareRelease(input());
  assert.equal(prepared.state, "prepared");
  const lock = await acquireMoneyLock();
  try { await assert.rejects(dispatch(lock, "payout", { method: "transfer", request: { asset: ASSETS.USDC, amount: "1", recipient: "bob.near", confidential: true } }), { code: "agent_released" }); }
  finally { await lock.release(); }
  assert.deepEqual(readOps(), []);
  await assert.rejects(prepare({ type: "agent_freeze" }), { code: "agent_released" });
  assert.deepEqual(await prepareRelease(input()), prepared);
});
test("a provider read failure never writes a release marker, even with allowBalance", async t => {
  evidence(t); t.mock.method(api, "getBalances", async () => { throw new Error("offline read failed"); });
  await assert.rejects(prepareRelease({ ...input(), allowBalance: true }));
  assert.equal(readFileSync(".env", "utf8"), "");
});
test("an open owner intent prevents release", async t => {
  evidence(t);
  t.mock.method(api, "generateIntent", async () => ({ type: "agent_freeze", correlation_id: "freeze", expires_at: new Date(Date.now() + 290_000).toISOString(), preview: { summary: "freeze" }, intent: walletIntent, signer: walletSigner }) as never);
  await prepare({ type: "agent_freeze" });
  assert.deepEqual(await prepareRelease(input()), { state: "refused", reason: "owner_action", balances: [] });
});
test("market payment-key funds are listed and require the explicit balance override", async t => {
  evidence(t); process.env.DASHBOARD_AREA = "market";
  const readKey = async () => [{ source: "payment-key" as const, asset: ASSETS.USDC, amount: "1" }];
  assert.deepEqual(await prepareRelease(input(), readKey), { state: "refused", reason: "balance", balances: await readKey() });
  assert.equal((await prepareRelease({ ...input(), allowBalance: true }, readKey)).state, "prepared");
});

test("re-reserving hosting does not authorize a send before the provider restore succeeds", async t => {
  evidence(t);
  writeFileSync(".env", `RESTORE_REQUIRED=${process.env.AGENT_ID}\n`);
  const lock = await acquireMoneyLock();
  try { await assert.rejects(dispatch(lock, "payout", { method: "transfer", request: { asset: ASSETS.USDC, amount: "1", recipient: "bob.near", confidential: true } }), { code: "agent_released" }); }
  finally { await lock.release(); }
  assert.deepEqual(readOps(), []);
});

test("release refuses provider evidence naming another agent", async t => {
  evidence(t);
  t.mock.method(api, "getAgent", async () => ({ id: "another-agent", status: "ARCHIVED", owner: { type: "near", account_id: "alice.near" } }) as never);
  assert.deepEqual(await prepareRelease(input()), { state: "refused", reason: "owner_changed", balances: [] });
  assert.equal(readFileSync(".env", "utf8"), "");
});

test("release refuses policy or balances naming another wallet", async t => {
  evidence(t);
  t.mock.method(api, "getPolicy", async () => ({ wallet_id: "other-wallet", policy: { frozen: true } }) as never);
  assert.deepEqual(await prepareRelease(input()), { state: "refused", reason: "owner_changed", balances: [] });
  t.mock.method(api, "getPolicy", async () => ({ wallet_id: "fixture-wallet", policy: { frozen: true } }) as never);
  t.mock.method(api, "getBalances", async (_id: string, query: { source?: string }) => ({ near_account_id: "other.near", source: query.source, balances: [] }) as never);
  assert.deepEqual(await prepareRelease(input()), { state: "refused", reason: "owner_changed", balances: [] });
  assert.equal(readFileSync(".env", "utf8"), "");
});
