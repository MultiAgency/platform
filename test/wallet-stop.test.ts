import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DelegateAction, encodeSignedDelegateAction, generateKey, Near, parsePublicKey, serializeDelegateAction, type PrivateKey } from "near-kit";
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
async function signedStop(over: { host?: string; owner?: string; agent?: string; expiresAt?: string; recipient?: string; freeze?: true } = {}, key = ownerKey) {
  const message = walletStopMessage({ host: over.host ?? HOST, owner: over.owner ?? OWNER, agent: over.agent ?? EVERY_AGENT, expiresAt: over.expiresAt ?? inMinutes(10),
    ...(over.freeze && { freeze: over.freeze }) });
  const nonce = randomBytes(32);
  const near = new Near({ network: "mainnet", privateKey: key.secretKey as PrivateKey, defaultSignerId: over.owner ?? OWNER });
  const signature = await near.signMessage({ message, recipient: over.recipient ?? HOST, nonce });
  return { message, nonce: nonce.toString("base64"), publicKey: signature.publicKey, signature: signature.signature };
}

/**
 * The provider's freeze intent as an agent server's `owner/prepare` answers it: a NEP-366 delegate calling `freeze_wallet`
 * that the owner's provider key (`PROVIDER_KEY`, which needn't be the key that signed the stop) signs.
 */
const PROVIDER_KEY = generateKey();
const SIGNER = { type: "near", account_id: OWNER, public_key: PROVIDER_KEY.publicKey.toString() };
const freezeIntent = (wallet: string, methodName = "freeze_wallet") => ({ standard: "nep366", payload: { receiverId: "outlayer.near",
  actions: [{ type: "FunctionCall", params: { methodName, args: { wallet_pubkey: wallet }, gas: "30000000000000", deposit: "0" } }] } });
const prepared = (agent: string, over: Record<string, unknown> = {}) => ({ correlationId: `c-${agent}-${randomBytes(4).toString("hex")}`,
  preview: { summary: "Freeze the agent" }, expiresAt: inMinutes(10), digest: null, intent: freezeIntent(`w-${agent}`), signer: SIGNER, ...over });
/** The owner's wallet signing a delegate action: by default exactly `freezeIntent(wallet)`. */
function signDelegate(wallet: string, { methodName = "freeze_wallet", signer = PROVIDER_KEY }: { methodName?: string; signer?: ReturnType<typeof generateKey> } = {}) {
  const publicKey = parsePublicKey(signer.publicKey.toString());
  const functionCall = { functionCall: { methodName, args: new TextEncoder().encode(JSON.stringify({ wallet_pubkey: wallet })), gas: 30_000_000_000_000n, deposit: 0n } };
  const action = new DelegateAction(OWNER, "outlayer.near", [functionCall], 5n, 100n, publicKey);
  const signature = signer.sign(createHash("sha256").update(serializeDelegateAction(action)).digest());
  return { ...freezeIntent(wallet), signed_delegate: encodeSignedDelegateAction({ signedDelegate: {
    delegateAction: { senderId: OWNER, receiverId: "outlayer.near", actions: [functionCall], nonce: 5n, maxBlockHeight: 100n, publicKey: { ed25519Key: { data: Array.from(publicKey.data) } } },
    signature: { ed25519Signature: { data: Array.from(signature.data) } } } } as never) };
}

/**
 * An agent server's owner procedures on loopback, as the gateway reaches them over oRPC: each call is recorded with the
 * actor the gateway named; `replies` answers each procedure (a function of its input).
 */
async function fakeAgent(t: import("node:test").TestContext, name: string) {
  const calls: { path: string; actor: string | undefined; input: any }[] = [];
  const replies: Record<string, (input: any) => { status: number; json: unknown }> = {
    "owner/prepare": () => ({ status: 200, json: prepared(name) }),
    "owner/submit": () => ({ status: 200, json: { status: "PENDING", failureCode: null } }),
    "owner/status": () => ({ status: 200, json: { stage: "submitted", status: "SUCCESS", failureCode: null, phase: "settled" } }),
  };
  const server = createServer((req, res) => {
    let text = ""; req.on("data", chunk => text += chunk);
    req.on("end", () => {
      const path = req.url!.replace(/^\/rpc\//, "");
      const input = text ? JSON.parse(text).json : undefined;
      calls.push({ path, actor: req.headers["x-gateway-actor"] as string | undefined, input });
      // Only the procedures this table defines: never a name inherited from Object.prototype.
      const reply = Object.hasOwn(replies, path) ? replies[path]!(input) : { status: 404, json: { defined: false, code: "NOT_FOUND", status: 404, message: "Not found" } };
      res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify({ json: reply.json }));
    });
  });
  const port = await listen(server);
  t.after(() => close(server));
  return { port, calls, replies, of: (path: string) => calls.filter(c => c.path === path) };
}

const consent = (agent: string, agentId: string, owner = OWNER, deployment = "staging"): VerifiedConsent => ({
  version: 1, id: randomBytes(32).toString("hex"), deployment, host: HOST, organization: "org_1", owner, agent, agentId, scopes: ["read", "treasury"],
  expiresAt: Date.now() + 86_400_000, message: "{}", nonce: "n", publicKey: ownerKey.publicKey.toString(), signature: "s" });

/** A gateway serving the wallet stop for three agents: two of the owner's (one not created yet) and one of another wallet. */
async function harness(t: import("node:test").TestContext) {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "wallet-stop-")); process.chdir(dir);
  writeFileSync(join(dir, "confirm.html"), "<!doctype html><title>Confirm</title>");
  const servers = { treasury: await fakeAgent(t, "treasury"), payout: await fakeAgent(t, "payout") };
  const agents: AgentEntry[] = [
    { name: "treasury", owner: OWNER, port: servers.treasury.port, area: "treasury", executor: true },
    { name: "payout", owner: OWNER, port: servers.payout.port, area: "payables", executor: true },
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
  const freeze = (body: object) => call(port, "/confirm/v1/wallet-stop/freeze", "POST", body);
  const freezeStatus = (body: object) => call(port, "/confirm/v1/wallet-stop/freeze-status", "POST", body);
  const live = () => consents.list({}).filter(c => !c.revoked).map(c => c.agent).sort();
  const records = () => existsSync(join(ROOT, "wallet-stops")) ? readdirSync(join(ROOT, "wallet-stops")).length : 0;
  const ownerCalls = () => [...servers.treasury.calls, ...servers.payout.calls];
  return { port, state, stops, consents, stop, freeze, freezeStatus, live, records, servers, ownerCalls };
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
  // Asking for the freeze too: the text ends `,"freeze":true`; absent is the only way of not asking.
  const freezing = walletStopMessage({ ...fields, freeze: true });
  assert.equal(freezing, message.slice(0, -1) + ',"freeze":true}');
  assert.equal(parseWalletStopMessage(freezing)?.freeze, true);
  assert.equal(parseWalletStopMessage(message)?.freeze, undefined, "a stop text from before freezing was offered is unchanged");
  assert.equal(parseWalletStopMessage(message.slice(0, -1) + ',"freeze":false}'), null, "false isn't canonical");
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

test("a stop without the freeze asks no agent to prepare one", async t => {
  const { stop, ownerCalls } = await harness(t);
  const answer = await stop(await signedStop());
  assert.equal(answer.status, 200);
  assert.ok(answer.body.agents.every((a: object) => !("freeze" in a)));
  assert.deepEqual(ownerCalls(), []);
});

test("a stop that says freeze prepares each created agent's agent_freeze through its own owner/prepare, and hands back the provider's intent unchanged", async t => {
  const { stop, servers, ownerCalls, stops } = await harness(t);
  const answer = await stop(await signedStop({ freeze: true }));
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(stops.map(s => s.agent).sort(), ["payout", "treasury"], "the stop itself still applies");
  for (const name of ["treasury", "payout"] as const) {
    const [call, ...more] = servers[name].of("owner/prepare");
    assert.equal(more.length, 0);
    assert.deepEqual(call!.input, { action: { type: "agent_freeze" }, signer: "wallet" }, "only agent_freeze, for the owner's own wallet");
    assert.equal(call!.actor, OWNER);
    const { freeze } = answer.body.agents.find((a: { agent: string }) => a.agent === name);
    assert.equal(freeze.state, "sign");
    assert.deepEqual(freeze.intent, freezeIntent(`w-${name}`), "exactly the provider's intent, from this agent's own server");
    assert.deepEqual(freeze.signer, SIGNER);
    assert.match(freeze.correlationId, new RegExp(`^c-${name}-`));
  }
  assert.deepEqual(answer.body.agents.find((a: { agent: string }) => a.agent === "own-unborn").freeze, { state: "not prepared", reason: "not created" });
  assert.equal(ownerCalls().filter(c => c.path !== "owner/prepare").length, 0, "nothing is submitted until the owner's wallet signs");
});

test("no one but the owner's full-access key gets a freeze prepared: a refused stop asks no agent", async t => {
  const { state, stop, ownerCalls } = await harness(t);
  assert.equal((await stop(await signedStop({ freeze: true }, generateKey()))).status, 403, "another key");
  const good = await signedStop({ freeze: true });
  assert.equal((await stop({ ...good, message: good.message.replace(',"freeze":true', "") })).status, 403, "the freeze can't be taken off a signed text");
  const plain = await signedStop();
  assert.equal((await stop({ ...plain, message: plain.message.replace(/}$/, ',"freeze":true}') })).status, 403, "nor added to one");
  state.key = "FunctionCall";
  assert.equal((await stop(good)).status, 403, "a function-call key of the owner");
  assert.deepEqual(ownerCalls(), []);
});

test("the owner's signature over the held intent is submitted through the agent's owner/submit and followed with owner/status; nothing else is", async t => {
  const { stop, freeze, freezeStatus, servers } = await harness(t);
  const signed = await signedStop({ freeze: true });
  const answer = await stop(signed);
  const held = answer.body.agents.find((a: { agent: string }) => a.agent === "treasury").freeze;
  const refused = async (body: object, status: number, pattern: RegExp) => {
    const reply = await freeze(body);
    assert.equal(reply.status, status, JSON.stringify(reply.body));
    assert.match(reply.body.error, pattern);
  };
  await refused({ stop: signed, agent: "treasury", signedData: signDelegate("w-treasury", { signer: generateKey() }) }, 400, /key that isn't the owner's/);
  await refused({ stop: signed, agent: "treasury", signedData: signDelegate("w-treasury", { methodName: "unfreeze_wallet" }) }, 400, /not the one prepared/);
  await refused({ stop: signed, agent: "treasury", signedData: signDelegate("w-payout") }, 400, /not the one prepared/);
  await refused({ stop: signed, agent: "own-unborn", signedData: signDelegate("w-treasury") }, 404, /No freeze/);
  await refused({ stop: signed, agent: "theirs", signedData: signDelegate("w-treasury") }, 404, /No freeze/);
  await refused({ stop: { ...signed, signature: (await signedStop({ freeze: true }, generateKey())).signature }, agent: "treasury", signedData: signDelegate("w-treasury") }, 403, /signature/);
  await refused({ stop: await signedStop({ freeze: true }), agent: "treasury", signedData: signDelegate("w-treasury") }, 404, /Send the stop first/);
  assert.equal(servers.treasury.of("owner/submit").length, 0, "nothing refused reaches the agent");

  const signedData = signDelegate("w-treasury");
  const submitted = await freeze({ stop: signed, agent: "treasury", signedData });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.deepEqual(submitted.body, { correlationId: held.correlationId, submitted: { status: "PENDING", failureCode: null } });
  const [call] = servers.treasury.of("owner/submit");
  assert.deepEqual(call!.input, { correlationId: held.correlationId, signedData });
  assert.equal(call!.actor, OWNER);
  assert.equal(servers.payout.of("owner/submit").length, 0);

  const followed = await freezeStatus({ stop: signed, agent: "treasury" });
  assert.equal(followed.status, 200);
  assert.deepEqual(followed.body, { correlationId: held.correlationId, status: { stage: "submitted", status: "SUCCESS", failureCode: null, phase: "settled" } });
  assert.deepEqual(servers.treasury.of("owner/status").map(c => c.input), [{ correlationId: held.correlationId }]);
  // Sent again, the stop says the freeze was submitted, and prepares none.
  const again = await stop(signed);
  assert.deepEqual(again.body.agents.find((a: { agent: string }) => a.agent === "treasury").freeze, { state: "submitted", correlationId: held.correlationId });
  assert.equal(servers.treasury.of("owner/prepare").length, 1);
  assert.equal((await freezeStatus({ stop: await signedStop(), agent: "treasury" })).status, 404, "another stop follows nothing");
});

test("a prepared reply that isn't a freeze for the owner's wallet is never handed to the page", async t => {
  const { stop, freeze, servers } = await harness(t);
  servers.treasury.replies["owner/prepare"] = () => ({ status: 200, json: prepared("treasury", { intent: freezeIntent("w-treasury", "unfreeze_wallet") }) });
  servers.payout.replies["owner/prepare"] = () => ({ status: 200, json: prepared("payout", { signer: { ...SIGNER, account_id: "other.near" } }) });
  const signed = await signedStop({ freeze: true });
  const answer = await stop(signed);
  assert.equal(answer.status, 200);
  for (const a of answer.body.agents.filter((a: { agent: string }) => a.agent !== "own-unborn")) {
    assert.equal(a.freeze.state, "not prepared", a.agent);
    assert.equal(a.freeze.intent, undefined);
    assert.match(a.freeze.reason, /wasn.t released: (it calls something other than freeze_wallet|its signer isn.t the owner.s NEAR account)/);
  }
  assert.equal((await freeze({ stop: signed, agent: "treasury", signedData: signDelegate("w-treasury", { methodName: "unfreeze_wallet" }) })).status, 404, "nothing withheld can be submitted");
  // A readable (NEP-413) freeze is the provider's choice too: the wallet shows its text.
  servers.treasury.replies["owner/prepare"] = () => ({ status: 200, json: prepared("treasury", { intent: { standard: "nep413", payload: { message: "freeze", recipient: "outlayer.near", nonce: "n" } } }) });
  servers.payout.replies["owner/prepare"] = () => ({ status: 500, json: { defined: false, code: "INTERNAL_SERVER_ERROR", status: 500, message: "The request could not be completed." } });
  const next = await stop(await signedStop({ freeze: true, agent: "treasury" }));
  assert.equal(next.body.agents[0].freeze.state, "sign");
  assert.equal(next.body.agents[0].freeze.intent.standard, "nep413");
  const failed = await stop(await signedStop({ freeze: true, agent: "payout" }));
  assert.equal(failed.status, 200, "the stop still applied");
  assert.equal(failed.body.agents[0].freeze.state, "not prepared");
  assert.match(failed.body.agents[0].freeze.reason, /couldn't prepare/);
});

test("sent again, a freeze still signable is handed back as it was; a lapsed one is prepared again only while the stop is valid, for the agent it named", async t => {
  const { state, stop, servers } = await harness(t);
  const soon = () => new Date(Date.now() + 1_500).toISOString();
  const lapse = () => new Promise(resolve => setTimeout(resolve, 1_600));
  for (const name of ["treasury", "payout"] as const) servers[name].replies["owner/prepare"] = () => ({ status: 200, json: prepared(name, { expiresAt: soon() }) });
  const signed = await signedStop({ freeze: true });
  const freezeOf = (answer: { body: { agents: { agent: string; freeze: any }[] } }, name: string) => answer.body.agents.find(a => a.agent === name)!.freeze;
  const first = await stop(signed);
  const second = await stop(signed);
  assert.deepEqual(freezeOf(second, "treasury"), freezeOf(first, "treasury"), "the same intent, not a new one");
  assert.equal(servers.treasury.of("owner/prepare").length, 1);
  // Both windows closed unsigned while the stop text is still valid; meanwhile the payout agent was replaced.
  await lapse();
  state.identity.payout = { agentId: "id-new", owner: OWNER };
  servers.treasury.replies["owner/prepare"] = () => ({ status: 200, json: prepared("treasury") });
  const third = await stop(signed);
  assert.equal(freezeOf(third, "treasury").state, "sign");
  assert.notEqual(freezeOf(third, "treasury").correlationId, freezeOf(first, "treasury").correlationId);
  assert.deepEqual(freezeOf(third, "payout"), { state: "not prepared", reason: "replaced" }, "the stop's agent is gone: its replacement isn't frozen by it");
  assert.deepEqual([servers.treasury.of("owner/prepare").length, servers.payout.of("owner/prepare").length], [2, 1]);

  // A stop text that has expired prepares nothing more once its freeze lapses: the owner signs a new stop.
  const brief = await signedStop({ freeze: true, agent: "treasury", expiresAt: soon() });
  servers.treasury.replies["owner/prepare"] = () => ({ status: 200, json: prepared("treasury", { expiresAt: soon() }) });
  assert.equal(freezeOf(await stop(brief), "treasury").state, "sign");
  await lapse();
  const late = await stop(brief);
  assert.equal(late.status, 200);
  assert.deepEqual(freezeOf(late, "treasury"), { state: "expired", reason: "The freeze and this stop expired unsigned. Sign a new stop to freeze." });
  assert.equal(servers.treasury.of("owner/prepare").length, 3);
  // A reply already past its window isn't handed out.
  servers.treasury.replies["owner/prepare"] = () => ({ status: 200, json: prepared("treasury", { expiresAt: new Date(Date.now() - 1_000).toISOString() }) });
  const stale = await stop(await signedStop({ freeze: true, agent: "treasury" }));
  assert.equal(freezeOf(stale, "treasury").state, "not prepared");
});
