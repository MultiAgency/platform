import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateKey } from "near-kit";
import { consentMessage, setupMessage } from "../src/contract/app-consent.js";
import { AppConsents, AppCredentials, sweepConsentKeys } from "../src/gateway/app-access.js";
import { APP_ROOT, appRoutes, confirms, type HostedSetup } from "../src/gateway/app-routes.js";
import { confirmRoutes } from "../src/gateway/app-confirm.js";
import { daoStopRoutes } from "../src/gateway/dao-stop.js";
import type { AgentEntry } from "../src/gateway/config.js";
import type { DaoVotes } from "../src/gateway/app-dao.js";
import type { DaoOwnerReads } from "../src/gateway/machine-authority.js";
import { sendFailure } from "../src/http.js";
import { rawKey } from "../src/nep413.js";

const HOST = "platform.test", DAO = "agentic.sputnik-dao.near";
const later = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
const close = (server: Server) => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
function call(port: number, path: string, method = "GET", token?: string, body?: object) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { ...(token && { authorization: `Bearer ${token}` }), "content-type": "application/json" } }, res => {
      let text = ""; res.on("data", chunk => text += chunk); res.on("end", () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : null }));
    }); req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}

/** A gateway serving `appRoutes` for one DAO-owned Treasury agent, with the DAO's chain reads and votes simulated. */
async function harness(t: import("node:test").TestContext) {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "app-dao-")); process.chdir(dir);
  const daoKey = generateKey(), publicKey = daoKey.publicKey.toString();
  const signer = { type: "near" as const, account_id: rawKey(publicKey).toString("hex"), public_key: publicKey };
  const policy = { roles: [], default_vote_policy: {}, proposal_bond: "100000000000000000000000", proposal_period: "604800000000000" };
  const state = { owner: signer.account_id as string, providerId: "provider-id" as string | null, dao: true, policyDown: false,
    /** What `findSignature` finds on chain: null until a proposal passes. */
    signature: null as Buffer | null, findDown: false, stopping: false,
    /** The agent's answers by procedure path (`/rpc/<path>`), as `{ status, json }`; anything else answers ok. */
    replies: {} as Record<string, { status: number; json: unknown }>,
    /** The areas this host sets up hosted agents for (its config's `appSetup`). */
    setupAreas: ["treasury", "payables"] as string[], autopilotDown: false };
  const forwarded: { path: string; headers: Record<string, unknown>; body: any }[] = [];
  const upstream = createServer((req, res) => { let text = ""; req.on("data", chunk => text += chunk); req.on("end", () => {
    forwarded.push({ path: req.url!, headers: req.headers, body: text ? JSON.parse(text) : null });
    const reply = state.replies[req.url!] ?? { status: 200, json: { ok: true } };
    res.writeHead(reply.status, { "content-type": "application/json" }); res.end(JSON.stringify(reply.status < 300 ? { json: reply.json } : reply.json));
  }); });
  const agent = { name: "treasury", owner: DAO, port: await listen(upstream), area: "treasury" as const, executor: true };
  /** The host's agents: a DAO's setup adds its reserved one, served by the same test agent. */
  const agents: AgentEntry[] = [agent];
  const setups: Parameters<HostedSetup>[0][] = [];
  const stops: { agent: string; dao: string }[] = [];
  const setup: HostedSetup = async input => {
    if (!state.setupAreas.includes(input.area)) throw new Error("This area is not available on this host");
    setups.push(input);
    const reserved = { name: "own-dao", owner: input.owner, port: agent.port, area: input.area, executor: true, deployment: input.deployment, organization: input.organization } as AgentEntry;
    if (!agents.some(a => a.name === reserved.name)) agents.push(reserved);
    return reserved;
  };
  const daoOwner: DaoOwnerReads = {
    policy: async () => { if (state.policyDown) throw new Error("rpc down"); return state.dao ? policy as never : null; },
    owner: async () => signer,
  };
  const daoVotes: DaoVotes = {
    latestBlock: async () => 1_000, nextProposalId: async () => 57,
    findSignature: async () => { if (state.findDown) throw new Error("indexer down"); return state.signature; },
  };
  const server = createServer(async (req, res) => { try {
    if (await confirmRoutes(req, res, new URL(req.url!, "http://x").pathname, HOST, confirms, APP_ROOT, agents, dir, () => state.stopping)) return;
    if (await daoStopRoutes(req, res, new URL(req.url!, "http://x").pathname, HOST, APP_ROOT, agents, () => state.stopping, { daoOwner, daoVotes,
      stopAutopilot: async (stopped, dao) => { stops.push({ agent: stopped.name, dao }); if (state.autopilotDown) throw new Error("agent down"); } })) return;
    if (!await appRoutes(req, res, new URL(req.url!, "http://x").pathname, HOST, agents, () => state.stopping, { daoOwner, daoVotes, setup, setupAreas: state.setupAreas })) { res.writeHead(404); res.end("{}"); }
  } catch (e) { sendFailure(res, e); } });
  const port = await listen(server);
  t.after(async () => { await close(server); await close(upstream); process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); });
  // The agent's server reports its identity; any chain read (the wallet path's DAO check) answers as a Sputnik DAO.
  const original = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    // The gateway's own calls to the agent (proposals) reach the test agent; its identity reads are answered here.
    if (url.pathname.startsWith("/rpc/") && url.pathname !== "/rpc/ownerIdentity") return original(input, init);
    if (url.pathname.startsWith("/rpc/")) return Response.json({ json: state.providerId === null ? { agentId: null, owner: null }
      : { agentId: state.providerId, owner: { type: "near", account_id: state.owner } } });
    return Response.json({ jsonrpc: "2.0", id: 1, result: { block_hash: "5f8R8jZuPxPXMKk7ghU8ZtMJdAfqgRqfxHP2Ke7F3rC7", block_height: 1, logs: [],
      result: [...Buffer.from(JSON.stringify(policy))] } });
  });
  const credentials = new AppCredentials(".app-access");
  const staging = credentials.issue({ deployment: "staging", host: HOST, label: "staging", days: 30 }).token;
  const production = credentials.issue({ deployment: "production", host: HOST, label: "production", days: 30 }).token;
  const text = (over: Partial<Parameters<typeof consentMessage>[0]> = {}) => consentMessage({ host: HOST, deployment: "staging", organization: "org_1",
    owner: DAO, agent: "treasury", agentId: "provider-id", scopes: ["read", "treasury"], expiresAt: later(90), ...over });
  const file = (over = {}, token = staging) => call(port, "/apps/v1/dao-consents", "POST", token, { message: text(over) });
  /** The DAO's MPC key signing a request's hash, as a passed `v1.signer` proposal does. */
  const vote = (hash: string, key = daoKey) => { state.signature = Buffer.from(key.sign(Buffer.from(hash, "hex")).data); };
  const rpc = (procedure: string, org = "org_1") => `/apps/v1/o/${org}/a/treasury/rpc/${procedure}`;
  /** Files a consent and has the DAO vote it through: the stored consent's id. */
  const consented = async () => {
    const { request: pending } = (await file()).body;
    vote(pending.hash);
    const signed = await call(port, `/apps/v1/dao-consents/${pending.hash}`, "GET", staging);
    assert.equal(signed.body.state, "signed");
    state.signature = null;
    return signed.body.consent.id as string;
  };
  return { port, state, forwarded, signer, staging, production, text, file, vote, rpc, consented, setups, credentials, daoVotes, stops };
}

test("a DAO files its consent for a vote: the platform picks the nonce and answers the proposal a member files", async t => {
  const { port, staging, file } = await harness(t);
  const identity = await call(port, "/apps/v1/agents/treasury", "GET", staging);
  assert.equal(identity.status, 200, JSON.stringify(identity.body));
  assert.deepEqual([identity.body.owner, identity.body.agentId, identity.body.signer], [DAO, "provider-id", "dao"]);

  const filed = await file();
  assert.equal(filed.status, 201, JSON.stringify(filed.body));
  const { request: pending, transactions } = filed.body;
  assert.match(pending.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual([pending.dao, pending.agentId, pending.scopes], [DAO, "provider-id", ["read", "treasury"]]);
  assert.ok(pending.votingUntil <= Date.now() + 7 * 86_400_000 + 1_000, "a vote must pass within Sputnik's default proposal period");
  assert.match(pending.description, new RegExp(pending.hash));
  const filing = transactions.proposal.actions[0].params;
  assert.equal(transactions.proposal.receiverId, DAO);
  assert.equal(filing.methodName, "add_proposal");
  assert.equal(filing.deposit, "100000000000000000000000", "the DAO's proposal bond, exactly");
  const signs = JSON.parse(Buffer.from(filing.args.proposal.kind.FunctionCall.actions[0].args, "base64").toString());
  assert.deepEqual(signs, { request: { path: "agent-owner", payload_v2: { Eddsa: pending.hash }, domain_id: 1 } }, "the proposal signs exactly this hash");
  assert.equal(transactions.proposalAndVote.actions[1].params.args.id, 57);
  assert.notEqual((await file()).body.request.hash, pending.hash, "each filing gets its own nonce");
});

test("a DAO's consent carries only read, treasury and treasury-execute, and only for its own agent as it is now", async t => {
  const { port, state, staging, production, file } = await harness(t);
  for (const scopes of [["owner"], ["read", "payout"], ["treasury", "owner"]] as const)
    assert.equal((await file({ scopes })).status, 400, scopes.join(","));
  assert.equal((await file({ owner: "other.sputnik-dao.near" })).status, 403, "another DAO");
  assert.equal((await file({ deployment: "production" })).status, 400, "another deployment's text");
  assert.equal((await file({}, production)).status, 400, "the calling deployment must be the one named");
  assert.equal((await file({ agentId: "earlier" })).status, 409, "another agent identity");
  const derived = state.owner;
  state.owner = "someone-else.near";
  assert.equal((await file()).status, 409, "an agent no longer owned by the DAO's derived account");
  state.owner = derived;
  state.providerId = null;
  assert.equal((await file()).status, 409, "an agent not created yet");
  state.providerId = "provider-id";
  state.policyDown = true;
  assert.equal((await file()).status, 503, "an unanswered DAO read files nothing");
  state.policyDown = false;
  state.dao = false;
  assert.equal((await file()).status, 409, "an owner that isn't a DAO");
  state.dao = true;
  const wallet = await call(port, "/apps/v1/consents", "POST", staging, { message: "x", nonce: "x", publicKey: "ed25519:11111111111111111111111111111111", signature: "x" });
  assert.equal(wallet.status, 400, "the wallet route still refuses an unsigned body");
});

test("the consent is stored once the DAO's key signs its exact hash; it then reaches only what read and treasury cover", async t => {
  const { port, state, forwarded, signer, staging, production, file, vote, rpc } = await harness(t);
  const { request: pending } = (await file()).body;
  const read = () => call(port, `/apps/v1/dao-consents/${pending.hash}`, "GET", staging);
  assert.deepEqual((await read()).body.state, "pending");
  assert.equal((await call(port, `/apps/v1/dao-consents/${pending.hash}`, "GET", production)).status, 404, "another deployment's request");
  assert.equal((await call(port, rpc("overview"), "POST", staging, {})).status, 403, "nothing reaches the agent before the vote");

  vote(pending.hash, generateKey());
  assert.equal((await read()).body.state, "pending", "a signature by any other key isn't the DAO's");
  state.findDown = true;
  assert.equal((await read()).status, 503, "an unanswered search changes nothing");
  state.findDown = false;

  vote(pending.hash);
  const signed = await read();
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(signed.body.state, "signed");
  assert.deepEqual([signed.body.consent.signer, signed.body.consent.owner, signed.body.consent.publicKey], ["dao", DAO, signer.public_key]);
  assert.equal(signed.body.consent.signature, undefined);
  assert.equal((await read()).body.consent.id, signed.body.consent.id, "read again, the same consent");

  for (const procedure of ["overview", "strategy/get", "strategy/save", "sweep", "proposals/create", "autopilot/enable", "autopilot/stop"])
    assert.equal((await call(port, rpc(procedure), "POST", staging, {})).status, 200, procedure);
  assert.equal(forwarded.at(-1)!.headers["x-gateway-actor"], "app:staging:org_1");
  const before = forwarded.length;
  for (const procedure of ["owner/prepare", "owner/submit", "proposals/approve", "proposals/reject", "executePlan", "rebalance", "payouts/request", "pay"])
    assert.equal((await call(port, rpc(procedure), "POST", staging, {})).status, 403, `${procedure}: the DAO signs only by vote, and gave no other scope`);
  assert.equal((await call(port, rpc("overview", "org_2"), "POST", staging, {})).status, 403, "another Organization");
  assert.equal(forwarded.length, before, "nothing refused was forwarded");

  state.owner = "someone-else.near";
  assert.equal((await call(port, rpc("overview"), "POST", staging, {})).status, 403, "ownership is re-read on every call");
  state.owner = signer.account_id;
  state.policyDown = true;
  assert.equal((await call(port, rpc("overview"), "POST", staging, {})).status, 503, "an unanswered DAO read forwards nothing");
  state.policyDown = false;
  state.providerId = "replacement";
  assert.equal((await call(port, rpc("overview"), "POST", staging, {})).status, 403, "a replaced agent isn't covered");
  state.providerId = "provider-id";

  assert.equal((await call(port, `/apps/v1/consents/${signed.body.consent.id}`, "DELETE", staging)).status, 200);
  assert.equal((await call(port, rpc("overview"), "POST", staging, {})).status, 403, "revoked");
  const log = readFileSync(join(".app-access", "access.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(log.filter(e => e.event !== "call").map(e => e.event), ["dao-consent-filed", "consent", "revoke"]);
  assert.equal(log.find(e => e.event === "consent").signer, "dao");
});

test("a DAO's vote that passes too late, or for an agent that changed meanwhile, stores nothing", async t => {
  const { port, state, staging, file, vote } = await harness(t);
  const { request: pending } = (await file()).body;
  state.providerId = "replacement";
  vote(pending.hash);
  assert.equal((await call(port, `/apps/v1/dao-consents/${pending.hash}`, "GET", staging)).status, 409, "the agent was replaced before the vote passed");
  assert.equal((await call(port, `/apps/v1/dao-consents/${pending.hash}`, "GET", staging)).status, 409, "and stays refused while it is");
  assert.equal(new AppConsents(".app-access").list({}).length, 0);
  state.providerId = "provider-id";
  // A vote that hasn't passed when its window closes: nothing is searched for or stored after that.
  state.signature = null;
  const late = (await file()).body.request;
  const path = join(".app-access", "dao-requests", `${late.hash}.json`);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), votingUntil: Date.now() - 1 }));
  vote(late.hash);
  assert.equal((await call(port, `/apps/v1/dao-consents/${late.hash}`, "GET", staging)).status, 410);
  assert.equal(new AppConsents(".app-access").list({}).length, 0);
});

test("consent records from before DAO consent load unchanged, as the owner wallet's", t => {
  const dir = mkdtempSync(join(tmpdir(), "app-dao-compat-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "consents"), { recursive: true, mode: 0o700 });
  const id = "a".repeat(64);
  writeFileSync(join(dir, "consents", `${id}.json`), JSON.stringify({ version: 1, id, deployment: "staging", host: HOST, organization: "org_1",
    owner: "owner.near", agent: "payout", agentId: "provider-id", scopes: ["read"], expiresAt: Date.now() + 86_400_000, createdAt: 1,
    message: "m", nonce: "n", publicKey: "ed25519:x", signature: "s", revoked: false, revokedAt: null }));
  const [record] = new AppConsents(dir).list({});
  assert.equal(record?.id, id);
  assert.equal(record?.signer, undefined);
});

const PROPOSAL = { id: "p-1", requestId: "r-1", agentId: "provider-id", deployment: "staging", organization: "org_1", source: "external",
  legs: [{ from: "nep141:usdc.test", to: "nep141:wrap.near", amount: "1000000", minAmountOut: "200000000000000000000000" }],
  quoted: [], policyRevision: 3, policyDigest: "d".repeat(64), strategyDigest: "s".repeat(64), createdAt: new Date().toISOString(),
  expiresAt: later(2), note: null, sha256: "e".repeat(64), state: "proposed", reason: null, approvedAt: null, planId: null, operations: [] };

test("a DAO votes on an app's proposal from the platform's own text, and the platform relays the signature once", async t => {
  const { port, state, forwarded, signer, staging, production, vote, consented } = await harness(t);
  const consent = await consented();
  state.replies["/rpc/proposals/get"] = { status: 200, json: PROPOSAL };
  state.replies["/rpc/proposals/approve"] = { status: 200, json: { ...PROPOSAL, state: "approved" } };
  const ask = (over = {}, token = staging) => call(port, "/apps/v1/dao-votes", "POST", token, { organization: "org_1", agent: "treasury", proposal: "p-1", verdict: "approve", ...over });

  const filed = await ask();
  assert.equal(filed.status, 201, JSON.stringify(filed.body));
  const read = forwarded.at(-1)!;
  assert.deepEqual([read.path, read.headers["x-gateway-actor"], read.headers["x-gateway-consent"], read.headers["x-gateway-host"]],
    ["/rpc/proposals/get", "app:staging:org_1", consent, HOST], "the proposal is read as this app's, under its DAO consent");
  const { request: pending } = filed.body;
  assert.match(pending.description, /Approve Treasury proposal p-1/);
  assert.match(pending.description, /1\. Swap 1000000 of nep141:usdc\.test for at least 0\.2 wNEAR/);
  assert.ok(pending.votingUntil <= Date.parse(PROPOSAL.expiresAt), "the vote must pass while the proposal is valid");
  assert.equal(filed.body.transactions.proposal.receiverId, DAO);
  assert.equal((await ask({ organization: "org_2" })).status, 403, "another Organization has no DAO consent");
  assert.equal((await ask({}, production)).status, 403, "another deployment has no DAO consent");

  const stateOf = () => call(port, `/apps/v1/dao-votes/${pending.hash}`, "GET", staging);
  assert.equal((await stateOf()).body.state, "pending");
  const before = forwarded.length;
  vote(pending.hash, generateKey());
  assert.equal((await stateOf()).body.state, "pending", "another key's signature relays nothing");
  assert.equal(forwarded.length, before);

  vote(pending.hash);
  const relayed = await stateOf();
  assert.equal(relayed.status, 200, JSON.stringify(relayed.body));
  assert.deepEqual([relayed.body.state, relayed.body.proposalState], ["relayed", "approved"]);
  const approval = forwarded.at(-1)!;
  assert.equal(approval.path, "/rpc/proposals/approve");
  assert.equal(approval.headers["x-gateway-consent"], consent);
  const { signed } = approval.body.json;
  assert.equal(signed.publicKey, signer.public_key, "signed by the DAO's derived key");
  assert.match(signed.message, /^Approve Treasury proposal p-1\n/);
  assert.equal((await stateOf()).body.state, "relayed");
  assert.equal(forwarded.length, before + 1, "relayed once");
  assert.equal((await call(port, `/apps/v1/dao-votes/${pending.hash}`, "GET", production)).status, 404);
});

test("a DAO vote relays nothing for a proposal that isn't open, a consent that ended, or an agent that refuses it", async t => {
  const { port, state, forwarded, staging, vote, consented } = await harness(t);
  const consent = await consented();
  const ask = () => call(port, "/apps/v1/dao-votes", "POST", staging, { organization: "org_1", agent: "treasury", proposal: "p-1", verdict: "reject" });
  state.replies["/rpc/proposals/get"] = { status: 200, json: { ...PROPOSAL, state: "approved" } };
  assert.equal((await ask()).status, 409, "only an open proposal");
  for (const expiresAt of ["not a date", new Date(Date.now() + 30_000).toISOString()]) {
    state.replies["/rpc/proposals/get"] = { status: 200, json: { ...PROPOSAL, expiresAt } };
    assert.equal((await ask()).status, 409, `a proposal valid until ${expiresAt} gets no vote`);
  }
  state.replies["/rpc/proposals/get"] = { status: 400, json: { defined: false, code: "BAD_REQUEST", status: 400, message: "not yours" } };
  assert.equal((await ask()).status, 409, "only this app's own proposal");
  state.replies["/rpc/proposals/get"] = { status: 200, json: PROPOSAL };

  const refused = (await ask()).body.request;
  state.replies["/rpc/proposals/reject"] = { status: 400, json: { defined: true, code: "not_open", status: 400, message: "closed meanwhile" } };
  vote(refused.hash);
  assert.equal((await call(port, `/apps/v1/dao-votes/${refused.hash}`, "GET", staging)).status, 409, "the agent's refusal stands");
  state.replies["/rpc/proposals/reject"] = { status: 200, json: { ...PROPOSAL, state: "rejected" } };
  assert.equal((await call(port, `/apps/v1/dao-votes/${refused.hash}`, "GET", staging)).body.proposalState, "rejected", "reading again relays the same signature");

  state.signature = null;
  const ended = (await ask()).body.request;
  assert.equal((await call(port, `/apps/v1/consents/${consent}`, "DELETE", staging)).status, 200);
  vote(ended.hash);
  const before = forwarded.length;
  assert.equal((await call(port, `/apps/v1/dao-votes/${ended.hash}`, "GET", staging)).status, 409, "the consent it was filed under ended");
  assert.equal(forwarded.length, before, "nothing relayed");

  // Another live DAO consent doesn't stand in for the one the vote was filed under.
  state.signature = null;
  const [first, second] = [await consented(), await consented()];
  const filed = (await ask()).body.request;
  const under = JSON.parse(readFileSync(join(".app-access", "dao-requests", `${filed.hash}.json`), "utf8")).under;
  assert.ok([first, second].includes(under));
  assert.equal((await call(port, `/apps/v1/consents/${under}`, "DELETE", staging)).status, 200);
  vote(filed.hash);
  const stood = forwarded.length;
  assert.equal((await call(port, `/apps/v1/dao-votes/${filed.hash}`, "GET", staging)).status, 409, "only the consent it was filed under");
  assert.equal(forwarded.length, stood, "nothing relayed");
});

test("under its consent a DAO is asked to vote only on a Treasury grant, freeze or unfreeze, and the app gets only the proposal", async t => {
  const { port, state, forwarded, staging, rpc, consented } = await harness(t);
  await consented();
  const prepare = (action: object, signer = "dao") => call(port, rpc("owner/prepare"), "POST", staging, { json: { action, signer } });
  const daoReply = { correlationId: "c-1", preview: { summary: "Freeze the agent" }, expiresAt: later(0.005), digest: null,
    dao: { owner: "x", transaction: { receiverId: "v1.signer", actions: [] }, proposal: null, proposalAndVote: null } };
  state.replies["/rpc/owner/prepare"] = { status: 200, json: daoReply };
  for (const action of [{ type: "agent_freeze" }, { type: "agent_unfreeze" }, { type: "grant_issue", label: "treasury" }]) {
    const prepared = await prepare(action);
    assert.equal(prepared.status, 200, `${action.type}: ${JSON.stringify(prepared.body)}`);
    assert.equal(prepared.body.json.dao.transaction.receiverId, "v1.signer");
  }
  const before = forwarded.length;
  for (const [action, signer] of [[{ type: "grant_issue", label: "payout" }, "dao"], [{ type: "agent_create", owner: { type: "near", account_id: "x", public_key: "ed25519:x" } }, "dao"],
    [{ type: "policy_update", changes: {} }, "dao"], [{ type: "agent_freeze" }, "wallet"]] as const)
    assert.equal((await prepare(action, signer)).status, 403, `${(action as { type: string }).type} as ${signer}`);
  assert.equal(forwarded.length, before, "nothing refused was forwarded");

  state.replies["/rpc/owner/prepare"] = { status: 200, json: { ...daoReply, dao: undefined, intent: { standard: "nep413", payload: { message: "m", recipient: "r", nonce: "n" } },
    signer: { type: "near", account_id: "x", public_key: "ed25519:x" } } };
  assert.equal((await prepare({ type: "agent_freeze" })).status, 403, "an intent the app could sign elsewhere is never released for a DAO");
  for (const procedure of ["owner/status", "owner/pending"]) assert.equal((await call(port, rpc(procedure), "POST", staging, { json: { correlationId: "c-1" } })).status, 200, procedure);
  assert.equal((await call(port, rpc("owner/submit"), "POST", staging, { json: { correlationId: "c-1", signedData: {} } })).status, 403, "the agent submits the DAO's signature itself");
});

test("an app gates its own DAO members with the platform's role reader: one copy of the rules", async () => {
  const { accessOf: sdk, mayCall } = await import("../src/contract/index.js");
  const { accessOf: gateway } = await import("../src/gateway/roles.js");
  assert.equal(sdk, gateway, "the gateway reads DAO roles with the SDK's function");
  const policy = { proposal_bond: "1", default_vote_policy: { threshold: [1, 2] }, roles: [
    { name: "council", kind: { Group: ["council.near"] }, permissions: ["*:AddProposal", "*:VoteApprove"], vote_policy: {} },
    { name: "voters", kind: { Group: ["voter.near"] }, permissions: ["call:VoteApprove"], vote_policy: {} },
    { name: "all", kind: "Everyone", permissions: ["call:AddProposal"], vote_policy: {} },
  ] };
  const owner = { account: DAO, policy, signer: "derived" };
  const council = sdk("council.near", owner)!, voter = sdk("voter.near", owner)!;
  assert.equal(sdk("anyone.near", owner), null, "Everyone's public rights admit no one");
  assert.ok(mayCall(council, "strategy/save") && mayCall(council, "proposals/create"));
  assert.ok(!mayCall(voter, "strategy/save"), "only a member who may change the DAO's policy saves its strategy");
  assert.ok(mayCall(voter, "proposals/create"), "Everyone's call:AddProposal lets a voter propose");
  assert.ok(mayCall(voter, "overview"));
});

test("a DAO sets up its hosted Treasury agent by vote; the setup consent asks only for the agent's creation, by a second vote", async t => {
  const { port, state, forwarded, staging, vote, setups } = await harness(t);
  const setupText = (over = {}) => setupMessage({ host: HOST, deployment: "staging", organization: "org_1", owner: DAO, area: "treasury", expiresAt: later(3), ...over });
  const fileSetup = (over = {}) => call(port, "/apps/v1/dao-setups", "POST", staging, { message: setupText(over) });
  assert.equal((await fileSetup({ area: "payables" })).status, 400, "Treasury only");
  state.setupAreas = ["payables"];
  assert.equal((await fileSetup()).status, 403, "a host that doesn't set up Treasury agents files no vote the DAO would waste");
  state.setupAreas = ["treasury", "payables"];
  assert.equal((await fileSetup({ expiresAt: later(8) })).status, 400, "within the proposal period");
  state.dao = false;
  assert.equal((await fileSetup()).status, 409, "an owner that isn't a DAO");
  state.dao = true;
  assert.equal((await call(port, "/apps/v1/setup", "POST", staging, { message: setupText(), nonce: "x", publicKey: "ed25519:11111111111111111111111111111111", signature: "x" })).status, 400,
    "the wallet route takes no unsigned text");

  const filed = await fileSetup();
  assert.equal(filed.status, 201, JSON.stringify(filed.body));
  const { request: pending } = filed.body;
  assert.match(pending.description, /set up a hosted treasury agent owned by this DAO/);
  const read = () => call(port, `/apps/v1/dao-setups/${pending.hash}`, "GET", staging);
  assert.equal((await read()).body.state, "pending");
  vote(pending.hash, generateKey());
  assert.equal((await read()).body.state, "pending", "another key's signature sets nothing up");
  assert.equal(setups.length, 0);
  vote(pending.hash);
  state.providerId = null;
  const reserved = await read();
  assert.equal(reserved.status, 200, JSON.stringify(reserved.body));
  assert.deepEqual([reserved.body.state, reserved.body.agent, reserved.body.consent.signer, reserved.body.consent.agentId, reserved.body.consent.scopes],
    ["reserved", "own-dao", "dao", "unborn", ["owner"]]);
  assert.deepEqual(setups, [{ owner: DAO, kind: "dao", area: "treasury", deployment: "staging", organization: "org_1" }]);
  assert.equal((await read()).body.agent, "own-dao", "read again, the same reservation");
  assert.equal(setups.length, 1);

  const identity = await call(port, "/apps/v1/agents/own-dao", "GET", staging);
  assert.deepEqual([identity.body.signer, identity.body.created], ["dao", false]);
  const rpc = (procedure: string) => `/apps/v1/o/org_1/a/own-dao/rpc/${procedure}`;
  const prepare = (action: object, signer = "dao") => call(port, rpc("owner/prepare"), "POST", staging, { json: { action, signer } });
  state.replies["/rpc/owner/prepare"] = { status: 200, json: { correlationId: "c-create", preview: { summary: "Create" }, expiresAt: later(0.007), digest: null,
    dao: { owner: "x", transaction: { receiverId: "v1.signer", actions: [] }, proposal: null, proposalAndVote: null } } };
  const before = forwarded.length;
  for (const action of [{ type: "agent_create", owner: { type: "near", account_id: "x", public_key: "ed25519:x" } }, { type: "agent_create", role: "payout" },
    { type: "agent_freeze" }, { type: "grant_issue", label: "treasury" }])
    assert.equal((await prepare(action)).status, 403, JSON.stringify(action));
  assert.equal((await prepare({ type: "agent_create" }, "wallet")).status, 403, "a DAO's setup is created by a DAO vote");
  for (const procedure of ["overview", "strategy/save", "proposals/create"])
    assert.equal((await call(port, rpc(procedure), "POST", staging, {})).status, 403, `${procedure}: a setup consent reaches nothing else`);
  assert.equal(forwarded.length, before, "nothing refused was forwarded");
  const created = await prepare({ type: "agent_create", role: "treasury" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.json.dao.transaction.receiverId, "v1.signer");
  assert.equal(JSON.parse(forwarded.at(-1)!.body.json ? JSON.stringify(forwarded.at(-1)!.body.json) : "{}").signer, "dao");

  state.providerId = "provider-id";
  assert.equal((await prepare({ type: "agent_create" })).status, 403, "once created, the setup consent prepares nothing");

  // Another setup that finds the reservation again, now owned by another account: refused, nothing stored.
  state.signature = null;
  const again = (await fileSetup()).body.request;
  vote(again.hash);
  const owner = state.owner;
  state.owner = "someone-else.near";
  const refused = await call(port, `/apps/v1/dao-setups/${again.hash}`, "GET", staging);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  state.owner = owner;
  assert.equal((await call(port, rpc("owner/status"), "POST", staging, { json: { correlationId: "c-create" } })).status, 200, "it may follow the creation it asked for");
});

test("the operator's key sweep leaves DAO consents alone: a DAO's derived key is never one of its account's keys", async t => {
  const { consented } = await harness(t);
  const id = await consented();
  const swept = await sweepConsentKeys(new AppConsents(".app-access"), async () => "absent");
  assert.deepEqual(swept.revoked, [], "nothing revoked");
  assert.equal(new AppConsents(".app-access").list({}).find(c => c.id === id)?.revoked, false);
});

test("a credential revoked while the DAO's signature is being read stores, reserves and relays nothing", async t => {
  const { port, state, forwarded, staging, credentials, daoVotes, file, vote, consented } = await harness(t);
  const revokeDuring = () => { const find = daoVotes.findSignature; daoVotes.findSignature = async (...args) => {
    for (const c of credentials.list()) if (c.deployment === "staging") credentials.revoke(c.id);
    return find(...args); }; };
  const consent = await consented();
  state.replies["/rpc/proposals/get"] = { status: 200, json: PROPOSAL };
  const votePending = (await call(port, "/apps/v1/dao-votes", "POST", staging, { organization: "org_1", agent: "treasury", proposal: "p-1", verdict: "approve" })).body.request;
  const consentPending = (await file()).body.request;
  revokeDuring();
  vote(votePending.hash);
  const before = forwarded.length;
  assert.equal((await call(port, `/apps/v1/dao-votes/${votePending.hash}`, "GET", staging)).status, 403, "no relay");
  assert.equal(forwarded.length, before);
  vote(consentPending.hash);
  assert.equal((await call(port, `/apps/v1/dao-consents/${consentPending.hash}`, "GET", staging)).status, 401, "the credential is gone");
  assert.deepEqual(new AppConsents(".app-access").list({}).map(c => c.id), [consent], "nothing stored");
});

test("a DAO that votes treasury-execute into its consent lets the app run plans; its grant's proposal says it authorizes swaps without a vote each time", async t => {
  const { port, state, forwarded, staging, file, vote, rpc } = await harness(t);
  const { request: pending } = (await file({ scopes: ["read", "treasury", "treasury-execute"] })).body;
  vote(pending.hash);
  assert.equal((await call(port, `/apps/v1/dao-consents/${pending.hash}`, "GET", staging)).body.consent.scopes.join(","), "read,treasury,treasury-execute");
  state.signature = null;
  for (const procedure of ["rebalance", "externalPlan", "executePlan"])
    assert.equal((await call(port, rpc(procedure), "POST", staging, {})).status, 200, procedure);
  assert.equal(forwarded.at(-1)!.headers["x-gateway-actor"], "app:staging:org_1", "the agent requires the strategy-bound grant for an app's plans");

  const { proposalDescription } = await import("../src/owner-intents.js");
  const base = { type: "grant_issue", summary: "Authorize the saved strategy", expiresAt: later(0.003), hash: "a".repeat(64) };
  assert.match(proposalDescription({ ...base, unattended: true }), /Authorizes: swaps within the saved strategy and the DAO's signed policy without a vote each time/);
  assert.doesNotMatch(proposalDescription(base), /Authorizes:/, "only a Treasury grant says it");
});

/** A plain GET of a public page: status, headers and body text. */
const page = (port: number, path: string, method = "GET") => new Promise<{ status: number; headers: Record<string, unknown>; text: string }>((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, path, method }, res => {
    let text = ""; res.on("data", chunk => text += chunk); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text }));
  }); req.on("error", reject); req.end();
});

test("each DAO request has a public check page: the exact text, and its hash recomputed, linked from the proposal", async t => {
  const { port, staging, file, vote } = await harness(t);
  const { request: pending, transactions } = (await file()).body;
  const link = `https://${HOST}/confirm/dao/${pending.hash}`;
  assert.ok(pending.description.includes(link), "the proposal's description links to it");
  assert.ok(transactions.proposal.actions[0].params.args.proposal.description.includes(link));

  const shown = await page(port, `/confirm/dao/${pending.hash}`);
  assert.equal(shown.status, 200);
  assert.match(String(shown.headers["content-type"]), /^text\/html/);
  assert.match(String(shown.headers["content-security-policy"]), /default-src 'none'/, "no script runs on it");
  assert.ok(shown.text.includes("it matches"));
  assert.ok(shown.text.includes(pending.hash));
  assert.ok(shown.text.includes("&quot;type&quot;:&quot;multiagency.app-consent&quot;"), "the exact text, escaped");
  assert.ok(!shown.text.includes("<script"), "no script");
  assert.ok(shown.text.includes("waiting for the vote"));
  assert.equal((await page(port, `/confirm/dao/${pending.hash}`, "HEAD")).status, 200);
  assert.equal((await page(port, `/confirm/dao/${pending.hash}`, "POST")).status, 405);
  assert.equal((await page(port, `/confirm/dao/${"0".repeat(64)}`)).status, 404);

  vote(pending.hash);
  await call(port, `/apps/v1/dao-consents/${pending.hash}`, "GET", staging);
  assert.ok((await page(port, `/confirm/dao/${pending.hash}`)).text.includes("the consent was stored"));

  // A record whose text no longer hashes to its id says so; one for another host isn't served here.
  const path = join(".app-access", "dao-requests", `${pending.hash}.json`), record = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...record, message: record.message.replace("org_1", "org_<b>") }));
  const tampered = await page(port, `/confirm/dao/${pending.hash}`);
  assert.ok(tampered.text.includes("does not match. Don't vote for it."));
  assert.ok(tampered.text.includes("org_&lt;b&gt;") && !tampered.text.includes("org_<b>"), "every value is escaped");
  writeFileSync(path, JSON.stringify({ ...record, host: "other.test" }));
  assert.equal((await page(port, `/confirm/dao/${pending.hash}`)).status, 404);
});

test("a request whose signature was found completes on a later read even after its vote window, as after a crash mid-step", async t => {
  const { port, state, forwarded, staging, file, vote, consented } = await harness(t);
  const edit = (hash: string, change: (r: any) => object) => {
    const path = join(".app-access", "dao-requests", `${hash}.json`);
    writeFileSync(path, JSON.stringify(change(JSON.parse(readFileSync(path, "utf8")))));
  };
  // Consent: stored, then the gateway stopped before recording it on the request; read after the window closed.
  const { request: pending } = (await file()).body;
  vote(pending.hash);
  const signed = (await call(port, `/apps/v1/dao-consents/${pending.hash}`, "GET", staging)).body;
  edit(pending.hash, r => ({ ...r, consent: null, votingUntil: Date.now() - 1 }));
  state.signature = null;
  const again = await call(port, `/apps/v1/dao-consents/${pending.hash}`, "GET", staging);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.consent.id, signed.consent.id, "the same consent, completed from the recorded signature");

  // Vote: relayed, then stopped before recording it; the next read relays the same signature again, which the agent keeps once.
  await consented();
  state.replies["/rpc/proposals/get"] = { status: 200, json: PROPOSAL };
  state.replies["/rpc/proposals/approve"] = { status: 200, json: { ...PROPOSAL, state: "approved" } };
  const { request: ballot } = (await call(port, "/apps/v1/dao-votes", "POST", staging, { organization: "org_1", agent: "treasury", proposal: "p-1", verdict: "approve" })).body;
  vote(ballot.hash);
  assert.equal((await call(port, `/apps/v1/dao-votes/${ballot.hash}`, "GET", staging)).body.state, "relayed");
  const first = forwarded.at(-1)!.body.json.signed;
  edit(ballot.hash, r => ({ ...r, relayed: null, votingUntil: Date.now() - 1 }));
  state.signature = null;
  const relayed = await call(port, `/apps/v1/dao-votes/${ballot.hash}`, "GET", staging);
  assert.equal(relayed.status, 200, JSON.stringify(relayed.body));
  assert.deepEqual(forwarded.at(-1)!.body.json.signed, first, "the same signature, never a new one");
});

test("a DAO stops its agent by its own vote, with no app: every consent for it ends and its autopilot turns off", async t => {
  const { port, state, staging, rpc, vote, consented, stops } = await harness(t);
  const consent = await consented();
  const hashOf = (html: string) => html.match(/Hash <code>([a-f0-9]{64})<\/code>/)![1]!;
  const opened = await page(port, "/confirm/dao/stop/treasury");
  assert.equal(opened.status, 200);
  assert.match(String(opened.headers["content-security-policy"]), /default-src 'none'/);
  assert.ok(opened.text.includes("Stop MultiAgency agent treasury (provider-id) on platform.test"));
  const hash = hashOf(opened.text);
  assert.equal(hashOf((await page(port, "/confirm/dao/stop/treasury")).text), hash, "one open stop per agent");
  assert.ok((await page(port, `/confirm/dao/${hash}`)).text.includes("it matches"), "the check page covers it too");
  assert.equal((await call(port, rpc("overview"), "POST", staging, {})).status, 200, "nothing changes before the vote");
  assert.equal((await page(port, "/confirm/dao/stop/treasury", "POST")).status, 405);

  vote(hash, generateKey());
  assert.ok((await page(port, "/confirm/dao/stop/treasury")).text.includes("waiting for the DAO&#39;s vote"), "another key's signature stops nothing");
  assert.equal(stops.length, 0);

  state.autopilotDown = true;
  vote(hash);
  const partial = await page(port, "/confirm/dao/stop/treasury");
  assert.ok(partial.text.includes("not confirmed off"), partial.text);
  assert.equal((await call(port, rpc("overview"), "POST", staging, {})).status, 403, "the consent ended at once");
  assert.equal(new AppConsents(".app-access").list({}).find(c => c.id === consent)?.revoked, true);
  state.autopilotDown = false;
  state.signature = null;
  const done = await page(port, "/confirm/dao/stop/treasury");
  assert.ok(done.text.includes("This DAO's agent was stopped") && done.text.includes("<td>off</td>"), done.text);
  assert.deepEqual(stops, [{ agent: "treasury", dao: DAO }, { agent: "treasury", dao: DAO }], "autopilot off asked again until it answered");
  const record = JSON.parse(readFileSync(join(".app-access", "dao-requests", `${hash}.json`), "utf8"));
  assert.equal(record.done.revoked.length, 1, "each consent revoked once");

  const reopened = await page(port, "/confirm/dao/stop/treasury");
  assert.notEqual(hashOf(reopened.text), hash, "after a stop, opening again files a new request");
  assert.ok(reopened.text.includes("An earlier stop was applied"));
  assert.equal(stops.length, 2, "and changes nothing by itself");
});

test("a stop is only for a created DAO-owned agent, and for the agent ID the DAO voted on", async t => {
  const { port, state, vote, consented, stops } = await harness(t);
  state.policyDown = true;
  assert.equal((await page(port, "/confirm/dao/stop/treasury")).status, 503, "an unanswered ownership read files nothing");
  state.policyDown = false;
  state.dao = false;
  assert.equal((await page(port, "/confirm/dao/stop/treasury")).status, 404, "an owner that isn't a DAO");
  state.dao = true;
  assert.equal((await page(port, "/confirm/dao/stop/nobody")).status, 404);
  state.signature = null;
  const consent = await consented();
  const hash = (await page(port, "/confirm/dao/stop/treasury")).text.match(/Hash <code>([a-f0-9]{64})<\/code>/)![1]!;
  // The agent was replaced before the vote passed: the consents naming the old ID end; the new agent is left alone.
  state.providerId = "replacement";
  vote(hash);
  const applied = await page(port, "/confirm/dao/stop/treasury");
  assert.ok(applied.text.includes("This DAO's agent was stopped"), applied.text);
  assert.equal(new AppConsents(".app-access").list({}).find(c => c.id === consent)?.revoked, true);
  assert.equal(stops.length, 0, "the replacement's autopilot isn't the one the DAO voted to stop");
});
