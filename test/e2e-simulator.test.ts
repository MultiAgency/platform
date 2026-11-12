import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentApi, AgentApiError, createGrantCredential } from "@near-intents-agent-api/sdk";
import { nep413Hash, verifyEd25519, signatureBytes } from "../src/nep413.js";
import { OWNER, PAYEE, PUBLIC_KEY, USDC, provider } from "./e2e/provider.mjs";
import { stackControls } from "./e2e/stack-controls.mjs";

/** The local stack's simulated provider and its file controls (test/e2e), as apps building on the stack reach them. */

type Sim = Awaited<ReturnType<typeof provider>>;
async function simulator(t: { after: (fn: () => unknown) => void }, options: Parameters<typeof provider>[1] = {}) {
  const directory = mkdtempSync(join(tmpdir(), "simulator-"));
  const sim = await provider(directory, options);
  t.after(async () => { await sim.close(); rmSync(directory, { recursive: true, force: true }); });
  return sim;
}
const post = (sim: Sim, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${sim.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const owner = { type: "near", account_id: OWNER, public_key: PUBLIC_KEY };
/** An owner intent generated and submitted (the simulator checks no signature). */
async function signed(sim: Sim, body: Record<string, unknown>) {
  const generated = await post(sim, "/v1/generate-intent", body);
  assert.equal(generated.status, 200, await generated.clone().text());
  const { correlation_id } = await generated.json() as { correlation_id: string };
  assert.equal((await post(sim, "/v1/submit-intent", { correlation_id })).status, 200);
}
/** A payout agent the owner creates (as an app's hosted setup does), with a payout grant whose token is answered. */
async function payoutAgent(sim: Sim, policy: Record<string, unknown>) {
  await signed(sim, { type: "agent_create", owner, name: "hosted", policy });
  const agent = sim.created().at(-1)!, credential = createGrantCredential();
  await signed(sim, { type: "grant_issue", agent_id: agent, label: "payout", credential: credential.commitment, expires_at: new Date(Date.now() + 86_400_000).toISOString() });
  return { agent, token: credential.token };
}
const payoutPolicy = (withdraw = false) => ({ frozen: false, actions: withdraw ? ["transfer", "withdraw"] : ["transfer"], confidential: true, owner_approval: true, assets: [USDC],
  destinations: { mode: "only", list: [{ action: "transfer", address: PAYEE, confidential: true }, ...withdraw ? [{ action: "withdraw", chain: "near", address: PAYEE, memo: null }] : []] },
  limits: { per_transaction: { [USDC]: "25000000" } }, max_actions_per_hour: 10, budget: { daily_usd: "50", weekly_usd: null, monthly_usd: "200" }, timelock_ms: 0 });
const providerError = async (response: Response) => new AgentApiError(response.status, await response.json() as never);

test("a payout grant is prepared and issued for an agent the owner created (platform#54)", async t => {
  const sim = await simulator(t);
  const { agent } = await payoutAgent(sim, payoutPolicy());
  const grants = await (await fetch(`${sim.url}/v1/agents/${agent}/grants`)).json() as { data: { label: string; revoked_at: string | null }[] };
  assert.deepEqual(grants.data.map(g => [g.label, g.revoked_at]), [["payout", null]]);
  assert.deepEqual(sim.errors, []);
});

test("a grant the simulator doesn't model is a provider refusal in the provider's error shape, not a 500 (platform#54)", async t => {
  const sim = await simulator(t);
  await signed(sim, { type: "agent_create", owner, name: "hosted", policy: payoutPolicy() });
  const agent = sim.created()[0]!, credential = createGrantCredential();
  for (const [agent_id, label] of [[agent, "bonus"], [sim.id, "payout"]] as const) {
    const answered = await post(sim, "/v1/generate-intent", { type: "grant_issue", agent_id, label, credential: credential.commitment, expires_at: new Date(Date.now() + 86_400_000).toISOString() });
    assert.equal(answered.status, 400);
    const error = await providerError(answered);
    assert.deepEqual([error.code, error.layer, error.retryable], ["unsupported_by_simulator", "request", false]);
    assert.match(error.message, /simulator/);
  }
  assert.deepEqual(sim.errors, [], "a declared refusal is no simulator failure");
});

test("a withdrawal's response can be lost as a transfer's can, after the provider accepted it (platform#52)", async t => {
  const sim = await simulator(t);
  const { agent, token } = await payoutAgent(sim, payoutPolicy(true));
  sim.fund(agent, 10_000_000n);
  sim.dropWithdrawResponse();
  await assert.rejects(post(sim, `/v1/agents/${agent}/withdraw`, { asset: USDC, amount: "1000000", chain: "near", recipient: PAYEE, confidential: true },
    { "x-grant-token": token, "idempotency-key": "w-1" }));
  assert.deepEqual(sim.transfers.map(p => [p.type, p.key, p.status]), [["withdraw", "w-1", "PENDING_APPROVAL"]]);
});

test("an owner-rejected held transfer or withdrawal supplies positive non-execution proof through provider status and history (platform#83)", async t => {
  const sim = await simulator(t);
  const { agent, token } = await payoutAgent(sim, payoutPolicy(true));
  sim.fund(agent, 10_000_000n);
  const api = new AgentApi({ apiKey: "local-simulator-only", baseUrl: sim.url });
  for (const method of ["transfer", "withdraw"] as const) {
    const response = await post(sim, `/v1/agents/${agent}/${method}`, { asset: USDC, amount: "1000000", recipient: PAYEE, confidential: true,
      ...(method === "withdraw" && { chain: "near" }) }, { "x-grant-token": token, "idempotency-key": `reject-${method}` });
    assert.equal(response.status, 200);
    const { correlation_id } = await response.json() as { correlation_id: string };
    const held = await api.getStatus(correlation_id);
    assert.ok(held.type === "transfer" || held.type === "withdraw");
    assert.equal(held.status, "PENDING_APPROVAL");
    assert.equal(held.details?.never_executed, undefined, "a held payout is still open");
    await signed(sim, { type: "approval_vote", agent_id: agent, approval_id: held.details?.approval_id, verdict: "reject" });
    const rejected = await api.getStatus(correlation_id);
    assert.deepEqual([rejected.status, rejected.failure_code, rejected.details],
      ["FAILED", "rejected_by_owner", { approval_id: held.details?.approval_id, never_executed: true }], method);
    const history = await api.getHistory(agent);
    assert.deepEqual(history.data.find(row => row.correlation_id === correlation_id), rejected, "history retains the same proof");
    assert.throws(() => sim.settle(correlation_id), /Not approved/, "a rejected payout cannot later settle");
  }
  assert.equal(sim.transfers.length, 2, "the original requests only; no replacement");
  assert.deepEqual(sim.errors, []);
});

test("a rejection prepared before approval cannot attach non-execution proof after the payout was released (platform#83)", async t => {
  const sim = await simulator(t);
  assert.equal((await post(sim, `/v1/agents/${sim.id}/transfer`, { recipient: PAYEE, asset: USDC, amount: "1000000", confidential: true },
    { "x-grant-token": sim.token, "idempotency-key": "released-before-reject" })).status, 200);
  const payment = sim.transfers[0]!;
  const request = { type: "approval_vote", agent_id: sim.id, approval_id: payment.approval, verdict: "reject" };
  const prepared = await (await post(sim, "/v1/generate-intent", request)).json() as { correlation_id: string };
  await signed(sim, { ...request, verdict: "approve" });
  for (const response of [await post(sim, "/v1/submit-intent", prepared), await post(sim, "/v1/generate-intent", request)]) {
    assert.equal(response.status, 409);
    const error = await providerError(response);
    assert.deepEqual([error.code, error.layer], ["approval_closed", "request"]);
  }
  const api = new AgentApi({ apiKey: "local-simulator-only", baseUrl: sim.url });
  assert.equal((await api.getStatus(payment.correlation)).status, "PROCESSING");
  sim.settle(payment.correlation, "FAILED");
  const failed = await api.getStatus(payment.correlation);
  assert.equal(failed.type, "transfer");
  assert.equal(failed.details?.never_executed, undefined, "failed after approval proves no non-execution");
  assert.deepEqual(sim.errors, []);
});

test("a recipient can be unregistered on a token, so a USDC withdrawal to it is refused recipient_not_registered (platform#52)", async t => {
  const sim = await simulator(t);
  sim.unregister(PAYEE);
  const registered = async (account: string) => {
    const answer = await post(sim, "/chain", { jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final",
      account_id: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", method_name: "storage_balance_of",
      args_base64: Buffer.from(JSON.stringify({ account_id: account })).toString("base64") } });
    return JSON.parse(Buffer.from((await answer.json() as { result: { result: number[] } }).result.result).toString());
  };
  assert.equal(await registered(PAYEE), null);
  assert.notEqual(await registered(OWNER), null);
});

test("an approved payout can end FAILED or REFUNDED, an approval can expire, and a payout can be refused by the provider's rules (platform#52)", async t => {
  const sim = await simulator(t);
  const transfer = (key: string, amount = "1000000") => post(sim, `/v1/agents/${sim.id}/transfer`, { recipient: PAYEE, asset: USDC, amount, confidential: true },
    { "x-grant-token": sim.token, "idempotency-key": key });
  for (const key of ["t-1", "t-2", "t-3"]) assert.equal((await transfer(key)).status, 200);
  const [first, second, third] = sim.transfers;
  for (const payment of [first!, second!]) await signed(sim, { type: "approval_vote", agent_id: sim.id, approval_id: payment.approval, verdict: "approve" });
  sim.settle(first!.correlation, "FAILED");
  sim.settle(second!.correlation, "REFUNDED");
  const status = async (correlation: string) => (await (await fetch(`${sim.url}/v1/status?correlation_id=${correlation}`)).json() as { status: string }).status;
  assert.deepEqual([await status(first!.correlation), await status(second!.correlation)], ["FAILED", "REFUNDED"]);
  assert.throws(() => sim.settle(second!.correlation, "SUCCESS"), /Not approved/);

  sim.expireApproval(third!.correlation);
  const approval = await (await fetch(`${sim.url}/v1/agents/${sim.id}/approvals/${third!.approval}`)).json() as { expires_at: string; status: string };
  assert.ok(Date.parse(approval.expires_at) <= Date.now(), "past its expiry");
  assert.equal(approval.status, "PENDING", "what the provider does with an expired approval is not modelled");

  sim.refuseNextPayout({ code: "spend_budget_exceeded", status: 403 });
  const refused = await transfer("t-4");
  const error = await providerError(refused);
  assert.deepEqual([refused.status, error.code, error.layer, error.retryable], [403, "spend_budget_exceeded", "budget", false]);
  assert.equal(sim.transfers.length, 3, "a refused payout records nothing at the provider");
  assert.equal((await transfer("t-5")).status, 200, "only the next one");
  assert.throws(() => sim.refuseNextPayout({ code: "made_up", status: 403 }), /code/);
});

test("the stack's controls sign an app's NEP-413 text as a payee too, never the platform's sign-in text (platform#52)", async () => {
  const controls = stackControls({ simulated: {}, dashboard: "https://localhost:1" }, { owner: OWNER, payees: [PAYEE, "builder.near"] });
  const nonce = Buffer.alloc(32, 7).toString("base64"), message = "Sign in to Covenant as a contributor", recipient = "covenant.local";
  for (const account of [PAYEE, "builder.near"]) {
    const signed = await controls.signPayee({ account, message, recipient, nonce });
    assert.equal(signed.accountId, account);
    assert.equal(signed.publicKey, PUBLIC_KEY);
    assert.ok(verifyEd25519(signed.publicKey, nep413Hash(message, Buffer.from(nonce, "base64"), recipient), signatureBytes(signed.signature)));
  }
  await assert.rejects(controls.signPayee({ account: OWNER, message, recipient, nonce }), /not one of the stack's payees/);
  await assert.rejects(controls.signPayee({ account: PAYEE, message: "Sign in to localhost:1", recipient, nonce }), /sign-in text/);
});
