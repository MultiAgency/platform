import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateKey, Near, type PrivateKey } from "near-kit";
import { AppConsents, type VerifiedConsent } from "../src/gateway/app-access.js";
import type { AgentEntry } from "../src/gateway/config.js";
import { walletStopRoutes } from "../src/gateway/wallet-stop.js";
import { EVERY_AGENT, parseWalletStopMessage, walletStopMessage } from "../src/gateway/wallet-stop-text.js";
import { sendFailure } from "../src/http.js";
import type { KeyState } from "../src/signin.js";

const HOST = "platform.test", OWNER = "owner.near", ROOT = ".app-access";
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
const close = (server: Server) => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
function call(port: number, path: string, method = "GET", body?: object) {
  return new Promise<{ status: number; body: any; type: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { "content-type": "application/json" } }, res => {
      let text = ""; res.on("data", chunk => text += chunk);
      res.on("end", () => { const type = String(res.headers["content-type"] ?? ""); resolve({ status: res.statusCode!, type, body: type.includes("json") && text ? JSON.parse(text) : text }); });
    }); req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}

/** The owner's wallet key, and a NEP-413 signature by it over a stop. */
const ownerKey = generateKey();
async function signedStop(over: { host?: string; owner?: string; agent?: string; expiresAt?: string; recipient?: string } = {}, key = ownerKey) {
  const message = walletStopMessage({ host: over.host ?? HOST, owner: over.owner ?? OWNER, agent: over.agent ?? EVERY_AGENT, expiresAt: over.expiresAt ?? inMinutes(10) });
  const nonce = randomBytes(32);
  const near = new Near({ network: "mainnet", privateKey: key.secretKey as PrivateKey, defaultSignerId: over.owner ?? OWNER });
  const signature = await near.signMessage({ message, recipient: over.recipient ?? HOST, nonce });
  return { message, nonce: nonce.toString("base64"), publicKey: signature.publicKey, signature: signature.signature };
}

const consent = (agent: string, agentId: string, owner = OWNER, deployment = "staging"): VerifiedConsent => ({
  version: 1, id: randomBytes(32).toString("hex"), deployment, host: HOST, organization: "org_1", owner, agent, agentId, scopes: ["read", "treasury"],
  expiresAt: Date.now() + 86_400_000, message: "{}", nonce: "n", publicKey: ownerKey.publicKey.toString(), signature: "s" });

/** A gateway serving the wallet stop for three agents: two of the owner's (one not created yet) and one of another wallet. */
async function harness(t: import("node:test").TestContext) {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "wallet-stop-")); process.chdir(dir);
  writeFileSync(join(dir, "confirm.html"), "<!doctype html><title>Confirm</title>");
  const agents: AgentEntry[] = [
    { name: "treasury", owner: OWNER, port: 1, area: "treasury", executor: true },
    { name: "payout", owner: OWNER, port: 2, area: "payables", executor: true },
    { name: "own-unborn", owner: OWNER, port: 3, area: "treasury", executor: true },
    { name: "theirs", owner: "other.near", port: 4, area: "treasury", executor: true },
  ];
  const state = {
    /** The owner's key as the chain reports it now. */
    key: "FullAccess" as KeyState, keyDown: false,
    /** Each agent's provider ID and current owner, as its server reports them; `null` ID: not created. */
    identity: { treasury: { agentId: "id-treasury", owner: OWNER }, payout: { agentId: "id-payout", owner: OWNER },
      "own-unborn": { agentId: null, owner: OWNER }, theirs: { agentId: "id-theirs", owner: "other.near" } } as Record<string, { agentId: string | null; owner: string }>,
    identityDown: false, autopilotDown: new Set<string>(), autopilotDelay: 0, stopping: false, mayUse: (_key: string) => true,
    onIdentity: null as null | (() => void | Promise<void>),
  };
  const stops: { agent: string; owner: string }[] = [];
  const server = createServer(async (req, res) => { try {
    if (!await walletStopRoutes(req, res, new URL(req.url!, "http://x").pathname, HOST, ROOT, agents, dir, () => state.stopping, {
      keyState: async (account, key) => { if (state.keyDown) throw new Error("rpc down"); return account === OWNER && key === ownerKey.publicKey.toString() ? state.key : "absent"; },
      walletOwner: async (account, agent) => {
        await state.onIdentity?.();
        if (state.identityDown) throw new Error("agent down");
        const found = state.identity[agent.name]!;
        return found.owner === account ? { agentId: found.agentId } : null;
      },
      stopAutopilot: async (agent, owner) => {
        stops.push({ agent: agent.name, owner });
        await new Promise(resolve => setTimeout(resolve, state.autopilotDelay));
        if (state.autopilotDown.has(agent.name)) throw new Error("agent down");
      },
      mayUse: key => state.mayUse(key) })) { res.writeHead(404); res.end("{}"); }
  } catch (e) { sendFailure(res, e); } });
  const port = await listen(server);
  t.after(async () => { await close(server); process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); });
  const consents = new AppConsents(ROOT);
  const stop = (body: object) => call(port, "/confirm/v1/wallet-stop", "POST", body);
  const live = () => consents.list({}).filter(c => !c.revoked).map(c => c.agent).sort();
  const records = () => existsSync(join(ROOT, "wallet-stops")) ? readdirSync(join(ROOT, "wallet-stops")).length : 0;
  return { port, state, stops, consents, stop, live, records };
}

test("the stop text is canonical JSON, and only its canonical form parses", () => {
  const fields = { host: HOST, owner: OWNER, agent: EVERY_AGENT, expiresAt: "2026-11-08T12:00:00.000Z" };
  const message = walletStopMessage(fields);
  assert.equal(message, '{"type":"multiagency.wallet-stop","version":1,"host":"platform.test","owner":"owner.near","agent":"*","expiresAt":"2026-11-08T12:00:00.000Z"}');
  assert.deepEqual(parseWalletStopMessage(message), { type: "multiagency.wallet-stop", version: 1, ...fields });
  assert.equal(parseWalletStopMessage(message.replace('"agent":"*",', '"agent":"*" ,')), null, "whitespace");
  assert.equal(parseWalletStopMessage(JSON.stringify({ ...JSON.parse(message), extra: 1 })), null, "an extra field");
  assert.equal(parseWalletStopMessage(message.replace('"*"', '"Bad Name"')), null, "not an agent name");
  assert.equal(parseWalletStopMessage(walletStopMessage({ ...fields, agent: "treasury" }))?.agent, "treasury");
});

test("a wallet owner stops every agent with no app: each one's consents end and its autopilot turns off", async t => {
  const { stops, consents, stop, live, records } = await harness(t);
  for (const c of [consent("treasury", "id-treasury"), consent("treasury", "id-treasury", OWNER, "other-app"), consent("payout", "id-payout"),
    consent("own-unborn", "unborn"), consent("theirs", "id-theirs", "other.near"), consent("treasury", "id-before", "former.near")]) consents.store(c);
  const answer = await stop(await signedStop());
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(live(), ["theirs", "treasury"], "another wallet's agent, and another wallet's consent on this one, are untouched");
  assert.deepEqual(stops.map(s => s.agent).sort(), ["payout", "treasury"], "autopilot is turned off on each created agent of the owner");
  assert.ok(stops.every(s => s.owner === OWNER));
  assert.deepEqual(answer.body.agents, [
    { agent: "treasury", agentId: "id-treasury", consentsEnded: 2, autopilot: "off" },
    { agent: "payout", agentId: "id-payout", consentsEnded: 1, autopilot: "off" },
    { agent: "own-unborn", agentId: null, consentsEnded: 1, autopilot: "not created" },
  ]);
  assert.equal(records(), 1);
});

test("a stop naming one agent stops only that one", async t => {
  const { stops, consents, stop, live } = await harness(t);
  for (const c of [consent("treasury", "id-treasury"), consent("payout", "id-payout")]) consents.store(c);
  const answer = await stop(await signedStop({ agent: "payout" }));
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(live(), ["treasury"]);
  assert.deepEqual(stops.map(s => s.agent), ["payout"]);
});

test("a stop only removes what was given before it applied, and applying it again ends nothing given after", async t => {
  const { state, stops, consents, stop, live } = await harness(t);
  consents.store(consent("treasury", "id-treasury"));
  state.autopilotDown.add("treasury");
  const signed = await signedStop();
  const first = await stop(signed);
  assert.equal(first.status, 200);
  assert.equal(first.body.agents.find((a: { agent: string }) => a.agent === "treasury").autopilot, "not confirmed off");
  assert.deepEqual(live(), []);
  // The owner consents again after the stop: their later choice. The same stop, sent again, retries only the autopilot.
  await new Promise(resolve => setTimeout(resolve, 5));
  consents.store(consent("treasury", "id-treasury"));
  state.autopilotDown.clear();
  const again = await stop(signed);
  assert.equal(again.status, 200);
  assert.deepEqual(live(), ["treasury"], "a consent given after the stop applied stays live");
  assert.deepEqual(again.body.agents.map((a: { autopilot: string }) => a.autopilot), ["off", "off", "not created"]);
  assert.deepEqual(stops.map(s => s.agent), ["treasury", "payout", "treasury"], "only the unconfirmed autopilot is asked again");
  // Once everything is off, sending it again asks nothing.
  const third = await stop(signed);
  assert.equal(third.status, 200);
  assert.equal(stops.length, 3);
});

test("a stop is refused, with nothing recorded or changed, unless the owner's own key signed this host's exact text now", async t => {
  const { state, stops, consents, stop, live, records } = await harness(t);
  consents.store(consent("treasury", "id-treasury"));
  const refused = async (body: object, status: number, pattern: RegExp) => {
    const answer = await stop(body);
    assert.equal(answer.status, status, JSON.stringify(answer.body));
    assert.match(answer.body.error, pattern);
  };
  const good = await signedStop();
  await refused({ ...good, message: good.message.replace("{", "{ ") }, 400, /canonical/);
  await refused(await signedStop({ host: "other.test", recipient: "other.test" }), 400, /another platform host/);
  await refused(await signedStop({ expiresAt: inMinutes(-1) }), 400, /expired/);
  await refused(await signedStop({ expiresAt: inMinutes(61) }), 400, /at most an hour/);
  await refused(await signedStop({ recipient: "other.test" }), 403, /signature/);
  await refused({ ...good, signature: (await signedStop()).signature }, 403, /signature/);
  await refused(await signedStop({}, generateKey()), 403, /full-access key of owner\.near/);
  state.key = "FunctionCall";
  await refused(good, 403, /full-access key of owner\.near/);
  state.key = "absent";
  await refused(good, 403, /full-access key of owner\.near/);
  state.key = "FullAccess"; state.keyDown = true;
  await refused(good, 503, /couldn't be checked/);
  state.keyDown = false; state.identityDown = true;
  await refused(good, 503, /couldn't be checked/);
  state.identityDown = false; state.stopping = true;
  await refused(good, 503, /restarting/);
  state.stopping = false;
  await refused(await signedStop({ agent: "theirs" }), 404, /No agent of owner\.near/);
  await refused(await signedStop({ agent: "nonesuch" }), 404, /No agent of owner\.near/);
  // The key is checked first: only the owner learns whether any agent of theirs is here.
  await refused(await signedStop({ owner: "nobody.near" }), 403, /full-access key of nobody\.near/);
  assert.equal(records(), 0, "nothing recorded");
  assert.deepEqual(live(), ["treasury"], "nothing ended");
  assert.equal(stops.length, 0);
});

test("an agent whose provider reports another owner now isn't stopped by this wallet", async t => {
  const { state, stops, consents, stop, live } = await harness(t);
  consents.store(consent("treasury", "id-treasury"));
  consents.store(consent("payout", "id-payout"));
  state.identity.payout = { agentId: "id-payout", owner: "buyer.near" };
  const answer = await stop(await signedStop());
  assert.equal(answer.status, 200);
  assert.deepEqual(live(), ["payout"]);
  assert.deepEqual(stops.map(s => s.agent), ["treasury"]);
});

test("a stop ends the owner's consents for the agent's name whatever provider ID they name, and asks only the agent it stopped", async t => {
  const { state, stops, consents, stop, live } = await harness(t);
  consents.store(consent("treasury", "id-old"));
  consents.store(consent("treasury", "id-treasury"));
  const signed = await signedStop({ agent: "treasury" });
  state.autopilotDown.add("treasury");
  const first = await stop(signed);
  assert.equal(first.status, 200);
  assert.equal(first.body.agents[0].consentsEnded, 2);
  assert.deepEqual(live(), [], "an earlier agent's consent under the same name ends too");
  // Replaced again before the retry: the stopped agent is gone, so there is nothing of it left to turn off.
  state.identity.treasury = { agentId: "id-new", owner: OWNER };
  state.autopilotDown.clear();
  const again = await stop(signed);
  assert.equal(again.body.agents[0].autopilot, "replaced");
  assert.equal(stops.length, 1, "the new agent's autopilot isn't the stopped agent's");
});

test("concurrent sends of one stop apply it once: its record counts each consent once", async t => {
  const { state, stops, consents, stop, records } = await harness(t);
  consents.store(consent("treasury", "id-treasury"));
  state.autopilotDelay = 30;
  const signed = await signedStop({ agent: "treasury" });
  const answers = await Promise.all([stop(signed), stop(signed), stop(signed)]);
  assert.deepEqual(answers.map(a => a.status), [200, 200, 200]);
  assert.deepEqual(answers.map(a => a.body.agents[0].consentsEnded), [1, 1, 1]);
  assert.equal(records(), 1);
  assert.equal(stops.length, 1, "the agent is asked once");
});

test("the stop page is the confirm build's; the stop is a POST, rate-limited per address", async t => {
  const { port, state, stop } = await harness(t);
  for (const path of ["/confirm/wallet/stop", "/confirm/wallet/stop/treasury"]) {
    const page = await call(port, path);
    assert.equal(page.status, 200, path);
    assert.match(page.body, /<title>Confirm<\/title>/);
  }
  assert.equal((await call(port, "/confirm/wallet/stop/Bad_Name")).status, 404);
  assert.equal((await call(port, "/confirm/v1/wallet-stop")).status, 405);
  state.mayUse = () => false;
  const limited = await stop(await signedStop());
  assert.equal(limited.status, 429);
});
