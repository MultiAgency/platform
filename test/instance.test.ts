import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { createRouterClient } from "@orpc/server";
import { router } from "../src/router.js";
import { api } from "../src/api.js";
import { mayCall } from "../src/gateway/allowlist.js";
import { freshDirectory } from "./fixtures/harness.js";
freshDirectory("instance-status");
const readerAccess = { canSign: false, canPropose: false, canVote: false, canExecute: false, canManage: false };
test("instance identity is private member-readable configuration with no provider dependency", async () => {
  mock.method(globalThis, "fetch", async () => assert.fail("Instance status must not call a provider"));
  const client = createRouterClient(router);
  process.env.AGENT_ID = "fixture";
  process.env.EXECUTOR = "off";
  assert.deepEqual(await client.instance(), { agentId: "fixture", executor: false });
  process.env.EXECUTOR = "on";
  assert.deepEqual(await client.instance(), { agentId: "fixture", executor: true });
  assert.equal(mayCall(readerAccess, "instance"), true);
  assert.equal(mayCall(readerAccess, "autopilot/stop"), false);
  process.env.EXECUTOR = "off";
  await assert.rejects(client.autopilot.stop(), /executor/);
  delete process.env.AGENT_ID;
  assert.deepEqual(await client.instance(), { agentId: null, executor: false });
});

test("gateway ownership evidence reads only the configured agent and leaves instance status provider-free", async t => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("Ownership must not read DAO funding or other setup state"));
  const getAgent = t.mock.method(api, "getAgent", async () => ({ owner: { type: "near", account_id: "owner.near" } }) as never);
  t.mock.method(api, "listGrants", async () => assert.fail("Ownership must not read or adopt grants"));
  process.env.AGENT_ID = "fixture";
  process.env.TREASURY_ACCOUNT = "linked-dao.near";
  const client = createRouterClient(router);
  assert.deepEqual(await client.ownerIdentity(), { agentId: "fixture", owner: { type: "near", account_id: "owner.near" } });
  assert.deepEqual(getAgent.mock.calls.map(call => call.arguments), [["fixture"]]);
  assert.equal(mayCall(readerAccess, "ownerIdentity"), false, "the narrow gateway read does not add a member permission");
  for (const missing of [{ owner: null }, {}]) {
    getAgent.mock.mockImplementation(async () => missing as never);
    assert.deepEqual(await client.ownerIdentity(), { agentId: "fixture", owner: null },
      "a successful provider read with missing ownership retains the configured agent identity");
  }
  getAgent.mock.mockImplementation(async () => { throw new Error("Provider unavailable"); });
  await assert.rejects(client.ownerIdentity(), { code: "INTERNAL_SERVER_ERROR" });
  assert.deepEqual(await client.instance(), { agentId: "fixture", executor: false });
  delete process.env.AGENT_ID;
  assert.deepEqual(await client.ownerIdentity(), { agentId: null, owner: null });
  delete process.env.TREASURY_ACCOUNT;
});

test("account names the agent's wallet and only the grants whose tokens this executor holds, and adopts nothing", async t => {
  const { createGrantCredential } = await import("@near-intents-agent-api/sdk");
  const [held, staged, other] = [createGrantCredential(), createGrantCredential(), createGrantCredential()];
  const live = (credential: string, id: string, label = "treasury") =>
    ({ grant_id: id, label, revoked_at: null, expires_at: new Date(Date.now() + 86_400_000).toISOString(), owner_message: { credential } });
  t.mock.method(api, "getAgent", async () => ({ owner: { type: "near", account_id: "owner.near" }, wallet: { near_account_id: "agent-wallet.near" } }) as never);
  // A newer live grant with an unknown token comes first: it must never be taken for the held one.
  t.mock.method(api, "listGrants", async () => [live(other.commitment, "g-other"), live(held.commitment, "g-held"), live(staged.commitment, "g-staged", "treasury:abc")] as never);
  Object.assign(process.env, { AGENT_ID: "fixture", EXECUTOR: "on", AGENT_GRANT_TOKEN: held.token, AGENT_GRANT_TOKEN_PENDING: staged.token });
  const client = createRouterClient(router);
  const answer = await client.account();
  assert.equal(answer.wallet, "agent-wallet.near");
  assert.equal(answer.grant?.id, "g-held", "matched by its token, not the list's order");
  assert.equal(answer.stagedGrant?.id, "g-staged");
  assert.equal(process.env.AGENT_GRANT_TOKEN, held.token, "reading promotes nothing");
  assert.equal(process.env.AGENT_GRANT_TOKEN_PENDING, staged.token);
  assert.equal(mayCall(readerAccess, "account"), true);

  process.env.AGENT_GRANT_TOKEN_PENDING = "";
  process.env.AGENT_GRANT_TOKEN = other.token.replace(/.$/, c => (c === "a" ? "b" : "a"));
  assert.deepEqual([(await client.account()).grant, (await client.account()).stagedGrant], [null, null], "no token of a live grant: none held");
  process.env.EXECUTOR = "off";
  process.env.AGENT_GRANT_TOKEN = held.token;
  assert.equal((await client.account()).grant, null, "an approve-only copy holds no grant");
  process.env.EXECUTOR = "on";
  delete process.env.AGENT_ID;
  assert.deepEqual(await client.account(), { agentId: null, executor: true, wallet: null, grant: null, stagedGrant: null });
  delete process.env.AGENT_GRANT_TOKEN;
});
