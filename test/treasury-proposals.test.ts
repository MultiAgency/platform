import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, beforeEach, mock, test } from "node:test";
import { RPCSerializer } from "@orpc/client";
import { call, ORPCError } from "@orpc/server";
import { generateKey, Near, type PrivateKey } from "near-kit";
import { authorityFixture, balanceView, fixtureGrant, marketTokens, policyView, quoteAt, timedPrices, wholeTokens } from "./fixtures/authority.js";
import { freshDirectory, offline } from "./fixtures/harness.js";
import { api } from "../src/api.js";
import { appScopesCover } from "../src/contract/app-access.js";
import { appConsent } from "../src/contract/app-consent.js";
import { MAX_OPEN_PROPOSALS, PROPOSAL_REFUSAL_CODES, proposalText, tokenAmount, type ProposalView } from "../src/contract/treasury-proposals.js";
import { proposalSignatureProblem } from "../src/gateway/app-access.js";
import { opsLog, readOps } from "../src/ops.js";
import { executePlan, savePlan, observe, type PlanEvent } from "../src/plans.js";
import { strategyGrantProblems } from "../src/planning/strategy-grant.js";
import { ASSETS, treasuryPolicy } from "../src/policy.js";
import { approveProposal, createProposal, executeProposal, getProposal, listProposals, rejectProposal, withdrawProposal } from "../src/proposals/service.js";
import { claim, close } from "../src/proposals/store.js";
import { PublicError } from "../src/public-error.js";
import { moveOnce } from "../src/synced.js";
import { resumeSendingForTests, stopSending } from "../src/lock.js";
import { treasuryRoutes } from "../src/rpc/treasury.js";
import { loadStrategy, saveStrategy } from "../src/strategy.js";

const HOST = "platform.test";
const app = { actor: "app:multiagency-treasury:org_1", consent: "c".repeat(64), consents: ["c".repeat(64)], host: HOST };
/** The same app calling under a second live consent (a renewal, or one adding a scope), the first still live. */
const renewed = { ...app, consent: "d".repeat(64), consents: ["c".repeat(64), "d".repeat(64)] };
/** The same app after its first consent ended. */
const ended = { ...app, consent: "d".repeat(64), consents: ["d".repeat(64)] };
const usdc = ASSETS.USDC, wnear = ASSETS.wNEAR;
/** The listed tokens; by default $1 with 0 decimals. A quote follows their prices, times `rate` percent: a market move. */
let tokens: Array<{ symbol: string; asset_id: string; decimals: number; price: number }>;
let book: Record<string, { public: bigint; confidential: bigint }>;
let revision: number, rate: number, warnings: string[], sends: string[], status: () => Promise<{ correlation_id: string; status: string }> | never;
let label: string | undefined;

freshDirectory("proposals");
beforeEach(() => {
  process.env.AGENT_GRANT_TOKEN = "ngt_test";
  book = Object.fromEntries(Object.values(ASSETS).map(asset => [asset, { public: 0n, confidential: 100n }]));
  tokens = wholeTokens();
  revision = 1; rate = 100; warnings = []; sends = []; label = undefined;
  offline();
  const authority = authorityFixture("treasury");
  mock.method(api, "getAgent", authority.getAgent);
  mock.method(api, "getWallet", authority.getWallet);
  mock.method(api, "getHistory", authority.getHistory);
  mock.method(api, "listGrants", async () => [fixtureGrant(label)]);
  mock.method(api, "getPolicy", async () => policyView(treasuryPolicy, revision));
  mock.method(api, "getTokens", async () => timedPrices(tokens));
  mock.method(api, "getBalances", async (_id: string, { source }: { source: "public" | "confidential" }) =>
    balanceView(source, Object.entries(book).map(([asset_id, balances]) => ({ asset_id, balance_raw: String(balances[source]) }))));
  status = async () => ({ correlation_id: "1", status: "SUCCESS" });
  mock.method(api, "getStatus", async () => status());
  mock.method(api, "forGrant", () => ({
    swap: async (_id: string, request: { dry?: boolean; origin_asset: string; destination_asset: string; amount: string }) => {
      const out = String(BigInt(quoteAt(tokens, request).amount_out) * BigInt(rate) / 100n);
      if (request.dry) return { quote: { amount_out: out, min_amount_out: out }, warnings: warnings.map(code => ({ code, detail: "d" })) };
      sends.push("swap");
      book[request.origin_asset]!.confidential -= BigInt(request.amount);
      book[request.destination_asset]!.confidential += BigInt(out);
      return { correlation_id: String(sends.length) };
    },
  }));
});
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); });

const owner = generateKey();
/** The owner's wallet signing a proposal's text with NEP-413 for `recipient`. */
async function sign(message: string, recipient = HOST, key = owner) {
  const nonce = randomBytes(32);
  const near = new Near({ network: "mainnet", privateKey: key.secretKey as PrivateKey, defaultSignerId: "owner.near" });
  const signature = await near.signMessage({ message, recipient, nonce });
  return { message, nonce: nonce.toString("base64"), publicKey: signature.publicKey, signature: signature.signature };
}
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
const propose = (requestId = "r1", over: object = {}) =>
  createProposal(app, { requestId, legs: [{ from: usdc, to: wnear, amount: "15" }], expiresAt: inAnHour(), ...over });
const approve = async (proposal: ProposalView) => approveProposal(app, { id: proposal.id, signed: await sign(proposalText(proposal, "approve")) });
const refusedWith = (code: string) => (error: unknown) => error instanceof ORPCError && (error.data as { code?: string })?.code === code;

test("a proposal stores the quoted terms and moves nothing; the same request answers it, other terms are refused", async () => {
  const proposal = await propose();
  assert.equal(proposal.state, "proposed");
  assert.deepEqual(proposal.legs, [{ from: usdc, to: wnear, amount: "15", minAmountOut: "15" }]);
  assert.equal(proposal.policyRevision, 1);
  assert.equal(proposal.deployment, "multiagency-treasury"); assert.equal(proposal.organization, "org_1");
  assert.deepEqual(await createProposal(app, { requestId: "r1", legs: [{ from: usdc, to: wnear, amount: "15" }], expiresAt: proposal.expiresAt }), proposal);
  await assert.rejects(propose("r1", { legs: [{ from: usdc, to: wnear, amount: "16" }] }), refusedWith("request_conflict"));
  assert.deepEqual(sends, []); assert.deepEqual(readOps(), []);
  assert.deepEqual(listProposals(app).proposals.map(p => p.id), [proposal.id]);
});

// Seen on platform staging, 2026-11-05: at a market price a leg's USD value isn't a whole number (0.5 USDC at $0.999701).
test("a proposal valued at a market price is stored, and its hash is reproducible", async () => {
  tokens = tokens.map(token => ({ ...token, price: 0.999701 }));
  const proposal = await propose();
  assert.equal(proposal.quoted[0]!.usdIn, 15 * 0.999701);
  assert.equal(getProposal(app, { id: proposal.id }).sha256, proposal.sha256);
});

test("at market prices and real decimals, a proposal holds its quoted floor through a price move and executes once", async () => {
  tokens = marketTokens();
  for (const token of tokens) book[token.asset_id] = { public: 0n, confidential: 100n * 10n ** BigInt(token.decimals) };
  const proposal = await propose("m1", { legs: [{ from: usdc, to: wnear, amount: "15000000" }] });
  // 15 USDC at $0.9997 is $14.9955; at 0.9997/2.37 wNEAR per USDC the quote is the floor, rounded down in raw units.
  const floor = "6327215189873417721518987";
  assert.deepEqual(proposal.legs, [{ from: usdc, to: wnear, amount: "15000000", minAmountOut: floor }]);
  assert.deepEqual(proposal.quoted, [{ amountOut: floor, costBps: 0, usdIn: 14.9955 }]);
  assert.match(proposalText(proposal, "approve"), /1\. Swap 15 USDC \(15000000\) for at least 6\.327215189873417721518987 wNEAR \(6327215189873417721518987\)/);
  assert.equal(getProposal(app, { id: proposal.id }).sha256, proposal.sha256);
  await approve(proposal);
  // The live quote falls 1%: inside the cost limit, but below the signed floor, so nothing is claimed or sent.
  rate = 99;
  await assert.rejects(executeProposal(app, { id: proposal.id }), (error: unknown) => refusedWith("not_executable")(error) && /floor/.test((error as Error).message));
  assert.deepEqual(sends, []); assert.deepEqual(readOps(), []);
  rate = 100;
  assert.equal((await executeProposal(app, { id: proposal.id })).state, "executed");
  assert.deepEqual(sends, ["swap"]);
  assert.equal((readOps()[0]!.request as { min_amount_out: string }).min_amount_out, floor);
  assert.equal(book[wnear]!.confidential, 100n * 10n ** 24n + BigInt(floor));
  assert.equal((await executeProposal(app, { id: proposal.id })).state, "executed");
  assert.deepEqual(sends, ["swap"], "asked again, nothing is sent");
});

test("only an app through the gateway proposes; the expiry is bounded; the owner's text names the exact terms", async () => {
  await assert.rejects(createProposal({ ...app, actor: "owner.near" }, {}), PublicError);
  await assert.rejects(createProposal({ ...app, consent: undefined }, {}), PublicError);
  await assert.rejects(createProposal({ ...app, consents: [] }, {}), PublicError, "the call's consent must be live");
  await assert.rejects(propose("r2", { expiresAt: new Date(Date.now() + 8 * 86_400_000).toISOString() }), refusedWith("expiry_invalid"));
  await assert.rejects(propose("r3", { expiresAt: new Date(Date.now() + 30_000).toISOString() }), refusedWith("expiry_invalid"));
  const proposal = await propose("r4", { legs: [{ from: usdc, to: wnear, amount: "15", minAmountOut: "14" }] });
  const text = proposalText(proposal, "approve");
  assert.match(text, /^Approve Treasury proposal [0-9a-f]{32}\n/);
  assert.match(text, /1\. Swap 0\.000015 USDC \(15\) for at least 0\.000000000000000000000015 wNEAR \(15\)/, "the floor is the quote's when it is higher");
  assert.match(text, new RegExp(`Proposal sha256 ${proposal.sha256}\\.$`));
  assert.equal(tokenAmount("120500000", 6), "120.5"); assert.equal(tokenAmount("1000000", 6), "1");
});

test("a proposal the provider warns about, or whose output the policy forbids, is not stored", async () => {
  warnings = ["high_fee"];
  await assert.rejects(propose(), refusedWith("not_proposable"));
  warnings = [];
  revision = 1;
  await assert.rejects(propose("r2", { legs: [{ from: usdc, to: wnear, amount: "1000" }] }), refusedWith("not_proposable"));
  assert.deepEqual(listProposals(app).proposals, []);
});

test("the owner approves the exact text for this host; then one execution sends it once", async () => {
  const proposal = await propose();
  await assert.rejects(executeProposal(app, { id: proposal.id }), refusedWith("not_approved"));
  await assert.rejects(approveProposal(app, { id: proposal.id, signed: await sign(proposalText(proposal, "approve").replace("15", "16")) }), refusedWith("signature_invalid"));
  await assert.rejects(approveProposal(app, { id: proposal.id, signed: await sign(proposalText(proposal, "approve"), "other.test") }), refusedWith("signature_invalid"));
  await assert.rejects(approveProposal(app, { id: proposal.id, signed: await sign(proposalText(proposal, "reject")) }), refusedWith("signature_invalid"));
  const signed = await sign(proposalText(proposal, "approve"));
  assert.equal((await approveProposal(app, { id: proposal.id, signed })).state, "approved");
  assert.equal((await approveProposal(app, { id: proposal.id, signed })).state, "approved", "the same signature again answers it");
  assert.deepEqual(sends, []);
  const done = await executeProposal(app, { id: proposal.id });
  assert.equal(done.state, "executed");
  assert.deepEqual(sends, ["swap"]);
  assert.equal(readOps().length, 1); assert.equal(readOps()[0]!.kind, "proposal");
  assert.equal(done.operations.length, 1);
  assert.equal((await executeProposal(app, { id: proposal.id })).state, "executed");
  assert.deepEqual(sends, ["swap"], "asked again, nothing is sent");
});

test("below the signed floor, or warned, an attempt claims nothing and a later one executes", async () => {
  // A cost limit this loose would allow the lower price: only the signed floor refuses it.
  saveStrategy({ ...loadStrategy(), maxCostBps: 1_000 });
  const proposal = await propose();
  await approve(proposal);
  rate = 90;
  await assert.rejects(executeProposal(app, { id: proposal.id }), (error: unknown) => refusedWith("not_executable")(error) && /floor/.test((error as Error).message));
  warnings = ["high_fee"]; rate = 100;
  await assert.rejects(executeProposal(app, { id: proposal.id }), refusedWith("not_executable"));
  assert.deepEqual(sends, []); assert.deepEqual(readOps(), []);
  assert.equal(getProposal(app, { id: proposal.id }).state, "approved");
  warnings = []; rate = 120;
  const done = await executeProposal(app, { id: proposal.id });
  assert.equal(done.state, "executed");
  assert.equal((readOps()[0]!.request as { min_amount_out: string }).min_amount_out, "18", "sent with the live quote's floor, above the signed one");
});

test("a policy or strategy change voids a proposal, at approval and at execution", async () => {
  const first = await propose("r1");
  revision = 2;
  await assert.rejects(approve(first), refusedWith("invalidated"));
  assert.equal(getProposal(app, { id: first.id }).state, "invalidated");
  revision = 1;
  assert.equal(getProposal(app, { id: first.id }).state, "invalidated", "a reverted policy doesn't revive it");
  const second = await propose("r2");
  await approve(second);
  saveStrategy({ ...loadStrategy(), maxCostBps: loadStrategy().maxCostBps + 1 });
  assert.equal((await executeProposal(app, { id: second.id })).state, "invalidated");
  assert.deepEqual(sends, []);
});

test("rejected, withdrawn, expired or under another consent, a proposal never executes", async () => {
  const rejected = await propose("r1");
  const wrong = await sign(proposalText(rejected, "approve"));
  assert.throws(() => rejectProposal(app, { id: rejected.id, signed: wrong }), refusedWith("signature_invalid"));
  assert.equal(rejectProposal(app, { id: rejected.id, signed: await sign(proposalText(rejected, "reject")) }).state, "rejected");
  await assert.rejects(approve(rejected), refusedWith("not_open"));
  assert.equal((await executeProposal(app, { id: rejected.id })).state, "rejected");

  const withdrawn = await propose("r2");
  await approve(withdrawn);
  assert.equal(withdrawProposal(app, { id: withdrawn.id }).state, "withdrawn");
  assert.equal((await executeProposal(app, { id: withdrawn.id })).state, "withdrawn");

  const other = await propose("r3");
  await approve(other);
  assert.equal(getProposal(renewed, { id: other.id }).state, "approved", "a second live consent withdraws nothing");
  await assert.rejects(executeProposal(ended, { id: other.id }), refusedWith("withdrawn"));
  assert.equal(getProposal(app, { id: other.id }).state, "withdrawn");
  assert.throws(() => getProposal({ ...app, actor: "app:another-app:org_1" }, { id: other.id }), refusedWith("not_found"));

  const expiring = await propose("r4");
  await approve(expiring);
  const later = () => new Date(Date.parse(expiring.expiresAt) + 1);
  assert.equal((await executeProposal(app, { id: expiring.id }, later)).state, "expired");
  assert.deepEqual(sends, []);
});

test("claiming and closing race for one record: a claimed proposal can't be closed, a closed one can't be claimed", async () => {
  const proposal = await propose();
  await approve(proposal);
  assert.equal(close(proposal.id, { state: "rejected", reason: "test", at: new Date().toISOString() }), true);
  assert.equal(claim(proposal.id, "plan"), false);
  const second = await propose("r2");
  await approve(second);
  assert.equal(claim(second.id, "00000000-0000-0000-0000-000000000000"), true);
  assert.equal(close(second.id, { state: "withdrawn", reason: "test", at: new Date().toISOString() }), false);
  // As if the process stopped after the claim, before the plan's: nothing was sent, and nothing ever will be.
  const stopped = getProposal(app, { id: second.id });
  assert.equal(stopped.state, "stopped"); assert.match(stopped.reason!, /nothing was sent/);
  assert.equal((await executeProposal(app, { id: second.id })).state, "stopped");
  assert.deepEqual(sends, []);
});

test("an unknown outcome reads unknown, blocks, and is never resent", async () => {
  const proposal = await propose();
  await approve(proposal);
  status = async () => { throw new Error("status unavailable"); };
  await assert.rejects(executeProposal(app, { id: proposal.id }), /Outcome unknown/);
  assert.equal(getProposal(app, { id: proposal.id }).state, "unknown");
  status = async () => ({ correlation_id: "1", status: "SUCCESS" });
  assert.equal((await executeProposal(app, { id: proposal.id })).state, "unknown");
  assert.deepEqual(sends, ["swap"]);
});

test("a proposal's plan runs only as its proposal, and no other plan runs as one", async () => {
  const { snapshot } = await observe();
  const leg = { type: "swap" as const, from: usdc, to: wnear, amount: "15", amountOut: "15", minAmountOut: "15", costBps: 0 };
  const run = async (id: string, proposal?: string) => { const events: PlanEvent[] = []; for await (const e of executePlan(id, undefined, { proposal })) events.push(e); return events; };
  assert.equal((await run(savePlan(snapshot, "proposal", "t", [leg], new Date(), "a".repeat(32)).id))[0]?.type, "rejected");
  assert.equal((await run(savePlan(snapshot, "external", "t", [leg]).id, "a".repeat(32)))[0]?.type, "rejected");
  assert.deepEqual(sends, []);
});

test("an app's plan executes only under a grant binding its strategy", async () => {
  const { snapshot } = await observe();
  const leg = { type: "swap" as const, from: usdc, to: wnear, amount: "15", amountOut: "15", minAmountOut: "15", costBps: 0 };
  const run = async () => { const events: PlanEvent[] = []; for await (const e of executePlan(savePlan(snapshot, "external", "t", [leg]).id, undefined, { beforeClaim: strategyGrantProblems })) events.push(e); return events; };
  label = "treasury";
  const refused = await run();
  assert.equal(refused[0]?.type, "rejected");
  assert.match((refused[0] as Extract<PlanEvent, { type: "rejected" }>).problems.join(), /grant doesn't bind the saved strategy/);
  assert.deepEqual(sends, []); assert.deepEqual(readOps(), []);
  label = undefined;
  assert.equal((await run()).at(-1)?.type, "action");
  assert.deepEqual(sends, ["swap"]);
});

test("through the router, app and machine-credential plans need the strategy-bound grant; the owner's own session doesn't", async () => {
  const { snapshot } = await observe();
  const leg = { type: "swap" as const, from: usdc, to: wnear, amount: "15", amountOut: "15", minAmountOut: "15", costBps: 0 };
  const run = async (actor: string) => {
    const events: PlanEvent[] = [];
    for await (const e of await call(treasuryRoutes.executePlan, { planId: savePlan(snapshot, "external", "t", [leg]).id }, { context: { actor } })) events.push(e as PlanEvent);
    return events;
  };
  label = "treasury";
  for (const actor of [app.actor, "machine:0b0e4c4e-6f2a-4c55-9d1a-3f2f5d4c1a10"]) {
    const refused = await run(actor);
    assert.equal(refused.length, 1, actor); assert.equal(refused[0]?.type, "rejected", actor);
    assert.match((refused[0] as Extract<PlanEvent, { type: "rejected" }>).problems.join(), /grant doesn't bind the saved strategy/, actor);
  }
  assert.deepEqual(sends, []); assert.deepEqual(readOps(), []);
  assert.equal((await run("owner.near")).at(-1)?.type, "action", "the owner's own session is unchanged");
  assert.deepEqual(sends, ["swap"]);
});

test("open proposals are limited per agent", async () => {
  for (let i = 0; i < MAX_OPEN_PROPOSALS; i++) await propose(`r${i}`, { legs: [{ from: usdc, to: wnear, amount: "1" }] });
  await assert.rejects(propose("one-more", { legs: [{ from: usdc, to: wnear, amount: "1" }] }), refusedWith("too_many_proposals"));
});

/** Hosted agents run side by side in one state directory: switching `AGENT_ID` is another agent's process there. */
async function asAgent<T>(id: string, run: () => Promise<T> | T) {
  const before = process.env.AGENT_ID;
  process.env.AGENT_ID = id;
  try { return await run(); } finally { process.env.AGENT_ID = before; }
}

test("agents sharing a state directory share no proposals: not their list, their requestIds or their limit", async () => {
  const other = "b".repeat(64);
  const mineOnA = await propose("weekly");
  // The same app and Organization, holding a consent on another owner's agent, reusing the requestId.
  const onB = await asAgent(other, () => createProposal(ended, { requestId: "weekly", legs: [{ from: usdc, to: wnear, amount: "15" }], expiresAt: inAnHour() }));
  assert.equal(onB.state, "proposed");
  assert.equal(onB.agentId, other);
  assert.equal((await getProposal(app, { id: mineOnA.id })).state, "proposed", "the first agent's proposal isn't withdrawn");
  assert.deepEqual(listProposals(app).proposals.map(p => p.agentId), [mineOnA.agentId], "each agent lists only its own");
  assert.deepEqual(await asAgent(other, () => listProposals(ended).proposals.map(p => p.agentId)), [other]);
  // Another deployment filling one agent's limit leaves the other agent's untouched.
  const crowd = { ...app, actor: "app:another-app:org_9" };
  for (let i = 1; i < MAX_OPEN_PROPOSALS; i++)
    await createProposal(crowd, { requestId: `r${i}`, legs: [{ from: usdc, to: wnear, amount: "1" }], expiresAt: inAnHour() });
  await assert.rejects(propose("one-more", { legs: [{ from: usdc, to: wnear, amount: "1" }] }), refusedWith("too_many_proposals"));
  assert.equal((await asAgent(other, () => createProposal(ended, { requestId: "next", legs: [{ from: usdc, to: wnear, amount: "1" }], expiresAt: inAnHour() }))).state, "proposed");
});

test("scopes: treasury covers proposals, treasury-execute adds plans only beside treasury, and a consent can't name it alone", () => {
  assert.equal(appScopesCover(["treasury"], "proposals/execute"), true);
  assert.equal(appScopesCover(["treasury"], "executePlan"), false);
  assert.equal(appScopesCover(["treasury", "treasury-execute"], "executePlan"), true);
  assert.equal(appScopesCover(["treasury-execute"], "executePlan"), false);
  assert.equal(appScopesCover(["read", "payout"], "proposals/create"), false);
  const consent = { type: "multiagency.app-consent", version: 1, host: HOST, deployment: "d", organization: "o", owner: "owner.near", agent: "a",
    agentId: "id", expiresAt: inAnHour() };
  assert.equal(appConsent.safeParse({ ...consent, scopes: ["treasury-execute"] }).success, false);
  assert.equal(appConsent.safeParse({ ...consent, scopes: ["treasury", "treasury-execute"] }).success, true);
});

test("the gateway accepts a relayed proposal signature only from the owner's full-access key, for this host", async () => {
  const body = async (recipient = HOST) => new RPCSerializer().serialize({ id: "a".repeat(32), signed: await sign("text", recipient) });
  assert.equal(await proposalSignatureProblem(await body(), HOST, "owner.near", async () => "FullAccess"), null);
  assert.match(await proposalSignatureProblem(await body("other.test"), HOST, "owner.near", async () => "FullAccess") ?? "", /doesn't match/);
  assert.match(await proposalSignatureProblem(await body(), HOST, "owner.near", async () => "FunctionCall") ?? "", /not a full-access key/);
  assert.match(await proposalSignatureProblem(await body(), HOST, "owner.near", async () => null) ?? "", /not a full-access key/);
  assert.match(await proposalSignatureProblem({ json: { id: "x" } }, HOST, "owner.near", async () => "FullAccess") ?? "", /Send the proposal id/);
});

test("once its swaps were sent, a proposal reads its true state under any consent, never withdrawn", async () => {
  const proposal = await propose();
  await approve(proposal);
  assert.equal((await executeProposal(app, { id: proposal.id })).state, "executed");
  assert.equal(getProposal(ended, { id: proposal.id }).state, "executed");
  assert.equal((await executeProposal(ended, { id: proposal.id })).state, "executed");
  assert.deepEqual(sends, ["swap"]);
});

test("an attempt that loses to a withdrawal says so, not that the proposal stays approved", async () => {
  const proposal = await propose();
  await approve(proposal);
  // Withdrawn while the attempt reads the provider, before its claim.
  const tokens = api.getTokens;
  let once = true;
  mock.method(api, "getTokens", async (...args: Parameters<typeof api.getTokens>) => { if (once) { once = false; withdrawProposal(app, { id: proposal.id }); } return tokens(...args); });
  await assert.rejects(executeProposal(app, { id: proposal.id }), (error: unknown) => refusedWith("not_executable")(error) && /withdrawn/.test((error as Error).message) && !/stays approved/.test((error as Error).message));
  assert.equal(getProposal(app, { id: proposal.id }).state, "withdrawn");
  assert.deepEqual(sends, []);
});

test("a swap the provider holds for the owner's vote reads unknown, saying so, and is never resent", async () => {
  const proposal = await propose();
  await approve(proposal);
  status = async () => ({ correlation_id: "1", status: "PENDING_APPROVAL" });
  const held = await executeProposal(app, { id: proposal.id });
  assert.equal(held.state, "unknown");
  assert.match(held.reason!, /held by the provider for the owner's vote/);
  assert.equal((await executeProposal(app, { id: proposal.id })).state, "unknown");
  assert.deepEqual(sends, ["swap"]);
});

test("proposals from before 0.5.3 are read where they are, by their own agent only, and never moved", async () => {
  const [first, second] = ["e".repeat(64), "f".repeat(64)];
  const approved = await asAgent(first, async () => { const p = await propose("approved"); await approve(p); return p; });
  const until = inAnHour();
  const open = await asAgent(first, () => propose("open", { expiresAt: until }));
  const theirs = await asAgent(second, () => propose("theirs"));
  // The layout of earlier builds: every agent's files directly in `.proposals/`.
  for (const agent of [first, second])
    for (const name of readdirSync(join(".proposals", agent))) renameSync(join(".proposals", agent, name), join(".proposals", name));
  const flat = () => readdirSync(".proposals").filter(name => name.endsWith(".json")).sort();
  const before = flat();
  assert.deepEqual(await asAgent(first, () => listProposals(app).proposals.map(p => [p.id, p.state]).sort()),
    [[approved.id, "approved"], [open.id, "proposed"]].sort(), "each agent reads its own, in place");
  assert.deepEqual(await asAgent(second, () => listProposals(app).proposals.map(p => p.id)), [theirs.id]);
  // Its requestId still answers the stored proposal, and acting on it writes beside it, where an earlier build reads it.
  assert.equal((await asAgent(first, () => propose("open", { expiresAt: until }))).id, open.id);
  assert.equal(await asAgent(first, () => withdrawProposal(app, { id: open.id }).state), "withdrawn");
  assert.ok(existsSync(join(".proposals", `${open.id}.final.json`)), "the final record sits beside the proposal");
  assert.deepEqual(flat().filter(name => !name.endsWith(".final.json")), before, "nothing moved");
  // The same requestId on another agent is that agent's own proposal, in its own directory.
  const elsewhere = await asAgent(second, () => propose("open"));
  assert.equal(elsewhere.id, open.id, "same app and requestId, so the same id");
  assert.equal(elsewhere.state, "proposed");
  assert.ok(existsSync(join(".proposals", second, `${open.id}.json`)));
  assert.equal(await asAgent(first, () => getProposal(app, { id: open.id }).state), "withdrawn", "the first agent's is untouched");
});

test("moving a record never replaces a different one", () => {
  mkdirSync("to");
  writeFileSync("a", "same"); writeFileSync(join("to", "a"), "same");
  assert.equal(moveOnce("a", join("to", "a")), true, "a move a crash cut short finishes");
  assert.equal(existsSync("a"), false);
  assert.equal(moveOnce("a", join("to", "a")), false);
  writeFileSync("b", "one"); writeFileSync(join("to", "b"), "other");
  assert.throws(() => moveOnce("b", join("to", "b")), /differs/);
  assert.equal(readFileSync(join("to", "b"), "utf8"), "other");
  assert.equal(readFileSync("b", "utf8"), "one");
});

test("every proposal refusal code the agent sends is one the package lists, and each listed code is sent", () => {
  const source = readFileSync(new URL("../src/proposals/service.ts", import.meta.url), "utf8");
  const sent = new Set([...source.matchAll(/refused\("([a-z_]+)"|code: "([a-z_]+)"/g)].map(m => m[1] ?? m[2]));
  assert.deepEqual([...sent].sort(), [...PROPOSAL_REFUSAL_CODES].sort());
});

/** A $90 cash floor in USDC; the book holds 100 USDC, so spending more than 10 of it crosses the floor. */
const floorAt90 = () => saveStrategy({ ...loadStrategy(), cashFloor: { usd: 90, assets: [usdc] } });
const spendUsdc = (amount: string) => ({ type: "swap" as const, from: usdc, to: wnear, amount, amountOut: amount, minAmountOut: amount, costBps: 0 });
const runPlan = async (id: string, options: Parameters<typeof executePlan>[2] = {}) => {
  const events: PlanEvent[] = [];
  for await (const e of executePlan(id, undefined, options)) events.push(e);
  return events;
};

test("an app's plan under treasury-execute sends no swap that would take the strategy's cash under its floor", async () => {
  floorAt90();
  const { snapshot } = await observe();
  const refused = await runPlan(savePlan(snapshot, "external", "t", [spendUsdc("15")]).id, { beforeClaim: strategyGrantProblems });
  assert.equal(refused.at(-1)?.type, "rejected");
  assert.match((refused.at(-1) as Extract<PlanEvent, { type: "rejected" }>).problems.join(), /cash under its floor/);
  assert.deepEqual(sends, []);
  assert.equal(readOps().at(-1)?.refused, "cash_floor_exceeded");
  // Landing exactly on the floor is allowed.
  assert.equal((await runPlan(savePlan(snapshot, "external", "t", [spendUsdc("10")]).id, { beforeClaim: strategyGrantProblems })).at(-1)?.type, "action");
  assert.deepEqual(sends, ["swap"]);
});

test("a plan the steward proposed sends no swap that would take the strategy's cash under its floor", async () => {
  floorAt90();
  const { snapshot } = await observe();
  const refused = await runPlan(savePlan(snapshot, "steward", "keep less USDC", [spendUsdc("15")]).id);
  assert.equal(refused.at(-1)?.type, "rejected");
  assert.deepEqual(sends, []);
  assert.equal(readOps().at(-1)?.refused, "cash_floor_exceeded");
});

test("an approved proposal that would take cash under the floor is refused before its claim and stays approved", async () => {
  floorAt90();
  const proposal = await propose("floor");
  await approve(proposal);
  await assert.rejects(executeProposal(app, { id: proposal.id }),
    (error: unknown) => refusedWith("not_executable")(error) && /cash under its floor/.test((error as Error).message));
  assert.equal(getProposal(app, { id: proposal.id }).state, "approved");
  assert.deepEqual(sends, []); assert.deepEqual(readOps(), []);
});

test("a strategy saved while a swap's provider reads are in flight refuses the swap", async () => {
  const { snapshot } = await observe();
  const plan = savePlan(snapshot, "external", "t", [spendUsdc("15")]);
  // The owner adds a floor between the plan's checks and the send: the reads dispatch makes see the new strategy.
  const grants = api.listGrants;
  mock.method(api, "listGrants", async (...args: Parameters<typeof api.listGrants>) => { floorAt90(); return grants(...args); });
  assert.equal((await runPlan(plan.id)).at(-1)?.type, "rejected");
  assert.deepEqual(sends, []);
  assert.equal(readOps().at(-1)?.refused, "strategy_changed");
});

test("cash committed to a send held for the owner's vote doesn't count toward the floor", async () => {
  floorAt90();
  const { snapshot } = await observe();
  // A 10 USDC swap held for the owner's approval: the reported balance still includes it.
  mkdirSync(".ops", { recursive: true });
  writeFileSync(opsLog(), [
    JSON.stringify({ at: "2026-11-06T00:00:00Z", idempotencyKey: "held", kind: "treasury", method: "swap", request: { origin_asset: usdc, destination_asset: wnear, amount: "10" } }),
    JSON.stringify({ idempotencyKey: "held", correlation_id: "op_held", status: "PENDING_APPROVAL" }), ""].join("\n"));
  // 100 USDC less the 10 held leaves 90: spending 5 more would take it to 85.
  const refused = await runPlan(savePlan(snapshot, "external", "t", [spendUsdc("5")]).id, { beforeClaim: strategyGrantProblems });
  assert.equal(refused.at(-1)?.type, "rejected");
  assert.equal(readOps().at(-1)?.refused, "cash_floor_exceeded");
  assert.deepEqual(sends, []);
});

test("while cash is under the floor, a proposal that adds cash still executes", async () => {
  book[usdc]!.confidential = 50n;
  floorAt90();
  const proposal = await propose("refill", { legs: [{ from: wnear, to: usdc, amount: "10" }] });
  await approve(proposal);
  await executeProposal(app, { id: proposal.id });
  assert.deepEqual(sends, ["swap"]);
  assert.equal(book[usdc]!.confidential, 60n);
});

test("an approved proposal that held sends would take under the floor is refused before its claim and stays approved", async () => {
  floorAt90();
  mkdirSync(".ops", { recursive: true });
  writeFileSync(opsLog(), [
    JSON.stringify({ at: "2026-11-06T00:00:00Z", idempotencyKey: "held", kind: "payout", method: "transfer", request: { asset: usdc, amount: "10", recipient: "p.near" } }),
    JSON.stringify({ idempotencyKey: "held", correlation_id: "op_held", status: "PENDING_APPROVAL" }), ""].join("\n"));
  const proposal = await propose("after-held", { legs: [{ from: usdc, to: wnear, amount: "5" }] });
  await approve(proposal);
  await assert.rejects(executeProposal(app, { id: proposal.id }), refusedWith("not_executable"));
  assert.equal(getProposal(app, { id: proposal.id }).state, "approved");
  assert.deepEqual(sends, []);
});

test("a stop during an approved proposal's last checks claims nothing, so it stays approved for after the restart", async () => {
  const proposal = await propose("restart");
  await approve(proposal);
  // The server is told to stop while the proposal's grant is read, just before its claim.
  const grants = api.listGrants;
  mock.method(api, "listGrants", async (...args: Parameters<typeof api.listGrants>) => { stopSending(); return grants(...args); });
  try {
    await assert.rejects(executeProposal(app, { id: proposal.id }), (error: unknown) => refusedWith("not_executable")(error) && /stopping/.test((error as Error).message));
    assert.equal(getProposal(app, { id: proposal.id }).state, "approved");
    assert.deepEqual(sends, []);
  } finally { resumeSendingForTests(); }
});
