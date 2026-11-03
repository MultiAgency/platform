import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateKey } from "near-kit";
import { consentMessage } from "../src/contract/app-consent.js";
import { AppConsents, AppCredentials } from "../src/gateway/app-access.js";
import { appRoutes } from "../src/gateway/app-routes.js";
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
    signature: null as Buffer | null, findDown: false, stopping: false };
  const forwarded: { path: string; headers: Record<string, unknown> }[] = [];
  const upstream = createServer((req, res) => { req.resume(); req.on("end", () => {
    forwarded.push({ path: req.url!, headers: req.headers }); res.writeHead(200, { "content-type": "application/json" }); res.end('{"json":{"ok":true}}');
  }); });
  const agent = { name: "treasury", owner: DAO, port: await listen(upstream), area: "treasury" as const, executor: true };
  const daoOwner: DaoOwnerReads = {
    policy: async () => { if (state.policyDown) throw new Error("rpc down"); return state.dao ? policy as never : null; },
    owner: async () => signer,
  };
  const daoVotes: DaoVotes = {
    latestBlock: async () => 1_000, nextProposalId: async () => 57,
    findSignature: async () => { if (state.findDown) throw new Error("indexer down"); return state.signature; },
  };
  const server = createServer(async (req, res) => { try {
    if (!await appRoutes(req, res, new URL(req.url!, "http://x").pathname, HOST, [agent], () => state.stopping, { daoOwner, daoVotes })) { res.writeHead(404); res.end("{}"); }
  } catch (e) { sendFailure(res, e); } });
  const port = await listen(server);
  t.after(async () => { await close(server); await close(upstream); process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); });
  // The agent's server reports its identity; any chain read (the wallet path's DAO check) answers as a Sputnik DAO.
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
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
  return { port, state, forwarded, signer, staging, production, text, file, vote, rpc };
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

test("a DAO's consent carries only read and treasury, and only for its own agent as it is now", async t => {
  const { port, state, staging, production, file } = await harness(t);
  for (const scopes of [["owner"], ["read", "payout"], ["treasury", "treasury-execute"]] as const)
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

  for (const procedure of ["overview", "strategy/get", "strategy/save", "sweep", "proposals/create", "autopilot/stop"])
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
  state.providerId = "provider-id";
  const path = join(".app-access", "dao-requests", `${pending.hash}.json`);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), votingUntil: Date.now() - 1 }));
  assert.equal((await call(port, `/apps/v1/dao-consents/${pending.hash}`, "GET", staging)).status, 410);
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
