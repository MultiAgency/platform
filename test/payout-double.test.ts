import { authorityFixture, balanceView, fixtureGrant, policyView } from "./fixtures/authority.js";
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { AgentApiError, type Policy } from "@near-intents-agent-api/sdk";
import { RPCHandler } from "@orpc/server/fetch";
import { api } from "../src/api.js";
import { appClient } from "../src/contract/app-client.js";
import type { OwnerResult } from "../src/contract/owner-client.js";
import { mandateDigest } from "../src/mandate.js";
import { requestKey } from "../src/payout-requests.js";
import { ASSETS, payoutPolicy } from "../src/policy.js";
import { recipientChain } from "../src/recipients.js";
import { router } from "../src/router.js";
import { payoutDouble } from "../src/testing/payout-double.js";
import type { DoubleOutcome, DoublePolicy } from "../src/testing/types.js";
import { freshDirectory, offline } from "./fixtures/harness.js";

/**
 * `@multiagency/sdk/testing`'s payout double against the platform's real money path. Each scenario runs twice through the
 * SDK's own `appClient`: once against the double, once against the agent's real procedures (the journal, the money lock,
 * `dispatch`, `authorize`) behind the provider stand-in below. Every answer must match, so the double can't drift from
 * the platform's request semantics without failing here.
 */

const ORG = "org_1", AGENT = "payout", PAYEE = "payee.near", ACTOR = `app:real:${ORG}`;
type World = {
  call: ReturnType<ReturnType<typeof appClient>["agent"]>["call"];
  reviewedPolicy(): { revision: number; digest: string };
  setPolicy(policy: DoublePolicy, state?: { status?: "SIGNED" | "APPLIED"; synced?: boolean }): void;
  setGrant(grant: { label: string; revoked?: boolean; expiresAt?: string } | null): void;
  setBalance(asset: string, raw: string): void;
  vote(requestId: string, verdict: "approve" | "reject"): void;
  settle(requestId: string, outcome?: DoubleOutcome): void;
  loseNextAnswer(): void;
  absent(account: string): void;
  unregistered(account: string, asset: string): void;
  unchecked(value: boolean): void;
};

const doubleWorld = (): World => {
  const double = payoutDouble({ organization: ORG, agent: AGENT, payees: [PAYEE] });
  const app = appClient({ base: double.base, credential: double.credential, fetch: double.fetch });
  return { call: app.agent(ORG, AGENT).call, reviewedPolicy: double.reviewedPolicy, setPolicy: double.setPolicy, setGrant: double.setGrant,
    setBalance: double.setBalance, vote: double.vote, settle: double.settle, loseNextAnswer: double.loseNextAnswer,
    absent: double.recipients.absent, unregistered: double.recipients.unregistered, unchecked: double.recipients.unchecked };
};

/** The agent's real procedures, as the gateway forwards an app's call to them, over a provider and chain kept here. */
const realWorld = (): World => {
  process.env.AGENT_GRANT_TOKEN = "ngt_fixture";
  let policy: Policy = payoutPolicy([PAYEE]), revision = 1, state = { status: "APPLIED", synced: true };
  let grant: (Omit<ReturnType<typeof fixtureGrant>, "revoked_at"> & { revoked_at: string | null }) | null = fixtureGrant("payout");
  const balances = new Map<string, string>([[ASSETS.USDC, "100000000"]]);
  const payments = new Map<string, { status: string; approval: string; key: string; method: string; asset: string; amount: string; rejected?: boolean }>();
  const absent = new Set<string>(), unregistered = new Set<string>();
  let loseNext = false, chainDown = false;
  offline();
  for (const [name, method] of Object.entries(authorityFixture())) mock.method(api, name as keyof typeof api, method as never);
  mock.method(api, "getPolicy", async () => ({ ...policyView(policy, revision), status: state.status, provider_policy_synced: state.synced }));
  mock.method(api, "listGrants", async () => grant ? [grant] : []);
  mock.method(api, "getBalances", async (_id: string, { source }: { source: string }) =>
    balanceView(source, source === "confidential" ? [...balances].map(([asset_id, balance_raw]) => ({ asset_id, balance_raw })) : []));
  mock.method(api, "getStatus", async (correlation_id: string) => {
    const payment = payments.get(correlation_id)!;
    return { correlation_id, agent_id: process.env.AGENT_ID, type: payment.method, status: payment.status,
      ...(payment.rejected && { failure_code: "rejected" }), details: { approval_id: payment.approval, ...(payment.rejected && { never_executed: true }) } };
  });
  // The provider: what it accepts and holds, and the destination rule it refuses under a code the platform can't prove sent nothing.
  const send = (method: "transfer" | "withdraw") => async (_id: string, body: { recipient: string; asset: string; amount: string }, { idempotencyKey }: { idempotencyKey: string }) => {
    const listed = policy.destinations.list.some(d => d.action === method && d.address === body.recipient);
    if (!policy.actions.includes(method) || !(policy.destinations.mode === "any" || (policy.destinations.mode === "only") === listed))
      throw new AgentApiError(403, { errors: [{ status: "403", code: method === "transfer" ? "policy_destination_denied" : "policy_action_denied", layer: "policy", title: "denied", meta: { retryable: false } }], meta: {} });
    const correlation = `op_${payments.size + 1}`;
    payments.set(correlation, { status: policy.owner_approval ? "PENDING_APPROVAL" : "SUCCESS", approval: crypto.randomUUID(), key: idempotencyKey, method, asset: body.asset, amount: body.amount });
    if (loseNext) { loseNext = false; throw new Error("socket hang up"); }
    return { correlation_id: correlation };
  };
  mock.method(api, "forGrant", () => ({ transfer: send("transfer"), withdraw: send("withdraw"), swap: assert.fail, shield: assert.fail, unshield: assert.fail }));
  recipientChain.exists = async account => { if (chainDown) throw new Error("chain unavailable"); return !absent.has(account); };
  recipientChain.registered = async (contract, account) => !unregistered.has(`${contract}\n${account}`);

  const handler = new RPCHandler(router), prefix = `/apps/v1/o/${ORG}/a/${AGENT}/rpc` as const;
  const app = appClient({ base: "https://platform.real.invalid", credential: "tap_real", fetch: async (input, init) => {
    const answered = await handler.handle(new Request(input, init), { prefix, context: { actor: ACTOR } });
    return answered.matched ? answered.response : new Response(null, { status: 404 });
  } });
  // A request's payment, by the identity the platform derives from the caller and the requestId.
  const paymentOf = (requestId: string) => [...payments.values()].find(p => p.key === requestKey(ACTOR, requestId))!;
  const call = app.agent(ORG, AGENT).call;
  return {
    call, reviewedPolicy: () => ({ revision, digest: mandateDigest(policy) }),
    setPolicy(next, nextState) { policy = structuredClone(next) as Policy; revision++; state = { ...state, ...nextState }; },
    setGrant(next) {
      grant = next && { ...fixtureGrant(next.label), ...(next.revoked && { revoked_at: new Date(0).toISOString() }), ...(next.expiresAt && { expires_at: next.expiresAt }) };
    },
    setBalance(asset, raw) { balances.set(asset, raw); },
    vote(requestId, verdict) { const payment = paymentOf(requestId); payment.status = verdict === "approve" ? "PROCESSING" : "FAILED"; payment.rejected = verdict === "reject"; },
    settle(requestId, outcome = "SUCCESS") {
      const payment = paymentOf(requestId);
      payment.status = outcome;
      if (outcome === "SUCCESS") balances.set(payment.asset, (BigInt(balances.get(payment.asset)!) - BigInt(payment.amount)).toString());
    },
    loseNextAnswer() { loseNext = true; },
    absent(account) { absent.add(account); },
    unregistered(account, asset) { assert.equal(asset, ASSETS.USDC); unregistered.add(`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1\n${account}`); },
    unchecked(value) { chainDown = value; },
  };
};

freshDirectory("payout-double");
afterEach(() => mock.restoreAll());

/** What an app decides by: the result's kind and code, or the request's state, status and code; never ids. */
const seen = (result: OwnerResult<unknown>) => result.ok
  ? (({ state, status, code, correlationId, failureCode, neverExecuted }) => ({ state, status, code, accepted: correlationId !== null, failureCode, neverExecuted }))(
    result.value as { state: string; status: string | null; code: string | null; correlationId: string | null; failureCode?: string | null; neverExecuted?: boolean })
  : { kind: result.kind, code: "code" in result ? result.code : undefined };
const usdc = (amount: number) => String(amount * 1_000_000);

/** Each scenario's answers, in order. */
const scenarios: Record<string, (world: World) => Promise<unknown[]>> = {
  "held, approved by the owner, then settled; asking again answers the same": async world => {
    const ask = () => world.call("payouts/request", { requestId: "r-1", asset: ASSETS.USDC, delivery: "intents", recipient: PAYEE, amount: usdc(5), expectedPolicy: world.reviewedPolicy() });
    const status = () => world.call("payouts/status", { requestId: "r-1" });
    const out = [seen(await ask()), seen(await status())];
    world.vote("r-1", "approve");
    out.push(seen(await status()), seen(await ask()));
    world.settle("r-1");
    out.push(seen(await status()), seen(await ask()), seen(await world.call("payouts/status", { requestId: "r-2" })));
    return out;
  },
  "rejected by the owner, or refunded, it reads failed": async world => {
    const reviewed = world.reviewedPolicy();
    const ask = (requestId: string, amount: number) => world.call("payouts/request", { requestId, asset: ASSETS.USDC, delivery: "intents", recipient: PAYEE, amount: usdc(amount), expectedPolicy: reviewed });
    const out = [seen(await ask("r-1", 1)), seen(await ask("r-2", 2))];
    world.vote("r-1", "reject"); world.vote("r-2", "approve");
    out.push(seen(await world.call("payouts/status", { requestId: "r-1" })), seen(await world.call("payouts/status", { requestId: "r-2" })));
    world.settle("r-2", "REFUNDED");
    out.push(seen(await world.call("payouts/status", { requestId: "r-2" })));
    return out;
  },
  "other terms under a used requestId are refused; malformed input is refused": async world => {
    const reviewed = world.reviewedPolicy();
    const ask = (requestId: string, recipient: string, amount: number) => world.call("payouts/request", { requestId, asset: ASSETS.USDC, delivery: "intents", recipient, amount: usdc(amount), expectedPolicy: reviewed });
    return [seen(await ask("r-1", PAYEE, 1)), seen(await ask("r-1", PAYEE, 2)), seen(await ask("r-1", "other.near", 1)), seen(await ask("bad id!", PAYEE, 1)),
      seen(await world.call("payouts/request", { requestId: "r-2", asset: ASSETS.USDC, delivery: { chain: "eth" }, recipient: PAYEE, amount: "1", expectedPolicy: reviewed }))];
  },
  "a policy changed since review is refused and recorded": async world => {
    const reviewed = world.reviewedPolicy();
    world.setPolicy({ ...payoutPolicy([PAYEE, "other.near"]) } as DoublePolicy);
    const ask = () => world.call("payouts/request", { requestId: "r-1", asset: ASSETS.USDC, delivery: "intents", recipient: PAYEE, amount: usdc(1), expectedPolicy: reviewed });
    return [seen(await ask()), seen(await ask()), seen(await world.call("payouts/status", { requestId: "r-1" }))];
  },
  "a request that opts out of the duplicate check is held beside an equal one": async world => {
    const reviewed = world.reviewedPolicy();
    const ask = (requestId: string, optOut: boolean) => world.call("payouts/request", { requestId, asset: ASSETS.USDC, delivery: "intents", recipient: PAYEE, amount: usdc(1), expectedPolicy: reviewed,
      ...(optOut && { allowDuplicateHeld: true }) });
    return [seen(await ask("r-1", false)), seen(await ask("r-2", false)), seen(await ask("r-3", true))];
  },
  "the balance less held payouts, a duplicate held payout and the per-transaction cap": async world => {
    world.setBalance(ASSETS.USDC, usdc(50));
    const reviewed = world.reviewedPolicy();
    const ask = (requestId: string, amount: number) => world.call("payouts/request", { requestId, asset: ASSETS.USDC, delivery: "intents", recipient: PAYEE, amount: usdc(amount), expectedPolicy: reviewed });
    const out = [seen(await ask("r-1", 20)), seen(await ask("r-2", 31)), seen(await ask("r-3", 20)), seen(await ask("r-4", 26)), seen(await ask("r-5", 10))];
    // Once the held one is approved and read, it no longer counts as held, and moving, it blocks new requests.
    world.vote("r-1", "approve");
    out.push(seen(await world.call("payouts/status", { requestId: "r-1" })), seen(await ask("r-6", 1)));
    return out;
  },
  "a frozen or unsynchronized policy is not in force": async world => {
    world.setPolicy({ ...payoutPolicy([PAYEE]), frozen: true } as DoublePolicy);
    const ask = (requestId: string) => world.call("payouts/request", { requestId, asset: ASSETS.USDC, delivery: "intents", recipient: PAYEE, amount: usdc(1), expectedPolicy: world.reviewedPolicy() });
    const out = [seen(await ask("r-1"))];
    world.setPolicy(payoutPolicy([PAYEE]) as DoublePolicy, { synced: false });
    out.push(seen(await ask("r-2")));
    return out;
  },
  "without a live payout grant a request is refused grant_purpose_denied, never grant_missing": async world => {
    const ask = (requestId: string) => world.call("payouts/request", { requestId, asset: ASSETS.USDC, delivery: "intents", recipient: PAYEE, amount: usdc(1), expectedPolicy: world.reviewedPolicy() });
    const out = [];
    for (const grant of [null, { label: "payout", revoked: true }, { label: "payout", expiresAt: new Date(Date.now() - 1000).toISOString() }, { label: "treasury" }]) {
      world.setGrant(grant); out.push(seen(await ask(`r-${out.length}`)));
    }
    world.setGrant({ label: "invoices" }); out.push(seen(await ask("r-invoices")));
    return out;
  },
  "a recipient missing on NEAR, or unchecked, is refused before anything is recorded": async world => {
    const ask = (recipient: string) => world.call("payouts/request", { requestId: "r-1", asset: ASSETS.USDC, delivery: "intents", recipient, amount: usdc(1), expectedPolicy: world.reviewedPolicy() });
    world.absent("ghost.near");
    const out = [seen(await ask("ghost.near")), seen(await world.call("payouts/status", { requestId: "r-1" }))];
    world.unchecked(true); out.push(seen(await ask(PAYEE)));
    world.unchecked(false); out.push(seen(await ask(PAYEE)));
    return out;
  },
  "a lost answer stays unknown and blocks new requests": async world => {
    const reviewed = world.reviewedPolicy();
    const ask = (requestId: string, recipient = PAYEE) => world.call("payouts/request", { requestId, asset: ASSETS.USDC, delivery: "intents", recipient, amount: usdc(1), expectedPolicy: reviewed });
    world.loseNextAnswer();
    return [seen(await ask("r-1")), seen(await world.call("payouts/status", { requestId: "r-1" })), seen(await ask("r-1")), seen(await ask("r-2"))];
  },
  "a transfer outside the agreed payees is refused payee_not_agreed before sending": async world => {
    const reviewed = world.reviewedPolicy();
    const ask = (requestId: string, recipient: string) => world.call("payouts/request", { requestId, asset: ASSETS.USDC, delivery: "intents", recipient, amount: usdc(1), expectedPolicy: reviewed });
    return [seen(await ask("r-1", "stranger.near")), seen(await ask("r-1", "stranger.near")), seen(await ask("r-2", PAYEE))];
  },
  "withdrawals: an agreed NEAR account, its asset in the policy, its recipient registered": async world => {
    const base = payoutPolicy([PAYEE]);
    world.setPolicy({ ...base, actions: ["transfer", "withdraw"], destinations: { mode: "only", list: [...base.destinations.list,
      { action: "withdraw", chain: "near", address: PAYEE, memo: null }, { action: "withdraw", chain: "near", address: "fresh.near", memo: null }] } } as DoublePolicy);
    world.unregistered("fresh.near", ASSETS.USDC);
    const reviewed = world.reviewedPolicy();
    const ask = (requestId: string, recipient: string, asset: string = ASSETS.USDC) =>
      world.call("payouts/request", { requestId, asset, delivery: { chain: "near" }, recipient, amount: usdc(1), expectedPolicy: reviewed });
    return [seen(await ask("w-1", PAYEE)), seen(await ask("w-2", "other.near")), seen(await ask("w-3", "fresh.near")), seen(await ask("w-4", PAYEE, ASSETS.wNEAR)),
      seen(await world.call("payouts/status", { requestId: "w-3" }))];
  },
  "a policy that holds nothing for the owner settles at once": async world => {
    world.setPolicy({ ...payoutPolicy([PAYEE]), owner_approval: false } as DoublePolicy);
    return [seen(await world.call("payouts/request", { requestId: "r-1", asset: ASSETS.USDC, delivery: "intents", recipient: PAYEE, amount: usdc(1), expectedPolicy: world.reviewedPolicy() }))];
  },
};

for (const [name, scenario] of Object.entries(scenarios))
  test(`payout double matches the platform: ${name}`, async () => {
    const real = await scenario(realWorld());
    mock.restoreAll();
    const double = await scenario(doubleWorld());
    assert.deepEqual(double, real);
  });

test("the double's held list and overview read as the platform's schemas, and its gateway refuses as the platform's does", async () => {
  const double = payoutDouble({ payees: [PAYEE] });
  const app = appClient({ base: double.base, credential: double.credential, fetch: double.fetch }), calls = app.agent("org_1", "payout");
  const overview = await calls.call("overview");
  assert.ok(overview.ok, JSON.stringify(overview));
  assert.deepEqual({ revision: overview.value.policy.revision, digest: overview.value.digest }, double.reviewedPolicy());
  assert.deepEqual([overview.value.notInForce, overview.value.agreed], [null, [PAYEE]]);
  const asked = await calls.call("payouts/request", { requestId: "r-1", asset: ASSETS.USDC, delivery: "intents", recipient: PAYEE, amount: "1000000", expectedPolicy: double.reviewedPolicy() });
  assert.ok(asked.ok && asked.value.state === "held");
  const held = await calls.call("held");
  assert.ok(held.ok);
  assert.deepEqual(held.value.map(h => [h.kind, h.request, h.correlationId]), [["payout", { recipient: PAYEE, asset: ASSETS.USDC, amount: "1000000", confidential: true }, asked.value.correlationId]]);
  double.vote("r-1", "approve");
  assert.deepEqual(await calls.call("held"), { ok: true, value: [] }, "once voted, the held list reads the provider and drops it");
  assert.deepEqual(double.requests().map(r => [r.requestId, r.status, r.providerStatus]), [["r-1", "PROCESSING", "PROCESSING"]]);

  assert.deepEqual(await calls.call("deposit"), { ok: false, kind: "unknown", procedure: "deposit", identity: {}, httpStatus: 501 });
  assert.deepEqual(double.unmodelled(), ["deposit"]);
  const stranger = appClient({ base: double.base, credential: "tap_other", fetch: double.fetch });
  assert.deepEqual(await stranger.agent("org_1", "payout").call("held"), { ok: false, kind: "session", status: 401, error: "The app credential is invalid, expired or revoked", source: "gateway" });
  const reader = payoutDouble({ scopes: ["read"] });
  const readOnly = appClient({ base: reader.base, credential: reader.credential, fetch: reader.fetch }).agent("org_1", "payout");
  assert.deepEqual(await readOnly.call("payouts/status", { requestId: "r-1" }),
    { ok: true, value: { requestId: "r-1", state: "not_found", status: null, correlationId: null, code: null, failureCode: null, neverExecuted: false } }, "read follows the app's own requests (#53)");
  assert.deepEqual(await readOnly.call("payouts/request", { requestId: "r-2", asset: ASSETS.USDC, delivery: "intents", recipient: PAYEE, amount: "1000000", expectedPolicy: reader.reviewedPolicy() }),
    { ok: false, kind: "forbidden", status: 403, error: "No live consent's scopes cover this procedure", source: "gateway", scope: "procedure", code: "scope" });
  assert.equal(((await app.agent("org_2", "payout").call("held")) as { code?: string }).code, "no_consent");
  double.revokeConsent();
  assert.deepEqual(await calls.call("held"),
    { ok: false, kind: "forbidden", status: 403, error: "No live owner consent covers this Organization and agent", source: "gateway", scope: "agent", code: "no_consent" });
});
