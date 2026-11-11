import assert from "node:assert/strict";
import { accessLogText } from "./fixtures/harness.js";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DelegateAction, encodeSignedDelegateAction, generateKey, Near, parsePublicKey, serializeDelegateAction, type PrivateKey } from "near-kit";
import { consentMessage, parseConsentMessage, parseSetupMessage, setupMessage } from "../src/contract/app-consent.js";
import { AppConsents, AppCredentials, DEFAULT_REQUESTS_PER_HOUR, MAX_CONSENTS_PER_DEPLOYMENT, MAX_REQUESTS_PER_HOUR, sweepConsentKeys, verifyConsent, verifySetup, type VerifiedConsent } from "../src/gateway/app-access.js";
import { APP_ROOT, appRoutes, confirms, type HostedSetup } from "../src/gateway/app-routes.js";
import { AppConfirms, confirmRoutes } from "../src/gateway/app-confirm.js";
import { APP_GATEWAY_CODES } from "../src/contract/app-access.js";
import { appClient, isDaoPrepared, isWalletPrepared, type AppPrepared } from "../src/contract/app-client.js";
import { BadRequest, sendFailure } from "../src/http.js";
import { daoPolicy } from "../src/chain.js";
import { payoutPolicy } from "../src/policy.js";
import { AuthorityUnanswered, resolveMachineAccess, resolveWalletAuthority } from "../src/gateway/machine-authority.js";
import { chainKeyState, hourlyLimit, type KeyLookup, type KeyState, type KeyStateLookup } from "../src/signin.js";

const HOST = "platform.test", NOW = Date.parse("2026-10-26T12:00:00Z");
const fullAccess: KeyLookup = async () => "FullAccess";
const later = (days: number, from = Date.now()) => new Date(from + days * 86_400_000).toISOString();
const fields = (over: Partial<Parameters<typeof consentMessage>[0]> = {}) => ({ host: HOST, deployment: "staging", organization: "org_1",
  owner: "owner.near", agent: "payout", agentId: "provider-id", scopes: ["read" as const], expiresAt: later(90), ...over });

/** Signs a consent the way a wallet does (near-kit's NEP-413 signer). */
async function signed(message: string, account = "owner.near", recipient = HOST, nonce: Buffer = randomBytes(32)) {
  const key = generateKey();
  const near = new Near({ network: "mainnet", privateKey: key.secretKey as PrivateKey, defaultSignerId: account });
  const signature = await near.signMessage({ message, recipient, nonce });
  return { message, nonce: nonce.toString("base64"), publicKey: signature.publicKey, signature: signature.signature };
}
const refusal = async (promise: Promise<unknown>, pattern: RegExp) => {
  await assert.rejects(promise, (error: unknown) => error instanceof BadRequest && pattern.test(error.message));
};

/** A prepared owner intent as the agent server answers it; NEP-366 is a freeze delegate signed by `DELEGATE_KEY`. */
const DELEGATE_KEY = generateKey();
const DELEGATE_INTENT = { standard: "nep366", payload: { receiverId: "outlayer.near",
  actions: [{ type: "FunctionCall", params: { methodName: "freeze_wallet", args: { wallet_pubkey: "w" }, gas: "30000000000000", deposit: "0" } }] } };
const preparedReply = (standard: string, correlationId = "c-1", expiresAt = later(0.005), policy?: object) => JSON.stringify({ json: { correlationId,
  preview: { summary: "s" }, expiresAt, digest: null, ...(policy && { policy }), signer: { type: "near", account_id: "owner.near", public_key: DELEGATE_KEY.publicKey.toString() },
  intent: standard === "nep413" ? { standard, payload: { message: "m", recipient: "r", nonce: "n" } } : standard === "nep366" ? DELEGATE_INTENT : { standard, payload: {} } } });
/** The owner's wallet signing a delegate action: by default exactly `DELEGATE_INTENT`. */
function signDelegate({ methodName = "freeze_wallet", signer = DELEGATE_KEY }: { methodName?: string; signer?: ReturnType<typeof generateKey> } = {}) {
  const publicKey = parsePublicKey(signer.publicKey.toString());
  const functionCall = { functionCall: { methodName, args: new TextEncoder().encode('{"wallet_pubkey":"w"}'), gas: 30_000_000_000_000n, deposit: 0n } };
  const action = new DelegateAction("owner.near", "outlayer.near", [functionCall], 5n, 100n, publicKey);
  const signature = signer.sign(createHash("sha256").update(serializeDelegateAction(action)).digest());
  return { ...DELEGATE_INTENT, signed_delegate: encodeSignedDelegateAction({ signedDelegate: {
    delegateAction: { senderId: "owner.near", receiverId: "outlayer.near", actions: [functionCall], nonce: 5n, maxBlockHeight: 100n, publicKey: { ed25519Key: { data: Array.from(publicKey.data) } } },
    signature: { ed25519Signature: { data: Array.from(signature.data) } } } } as never) };
}

test("a consent text is accepted only in its exact canonical form", () => {
  const text = consentMessage(fields({ scopes: ["read"] }));
  assert.deepEqual(parseConsentMessage(text)?.agent, "payout");
  const value = JSON.parse(text);
  for (const variant of [JSON.stringify(value, null, 1), JSON.stringify({ version: 1, ...value }), JSON.stringify({ ...value, extra: 1 }),
    JSON.stringify({ ...value, scopes: ["read", "read"] }), JSON.stringify({ ...value, scopes: ["admin"] }), JSON.stringify({ ...value, scopes: ["read", "owner"] }), "not json"])
    assert.equal(parseConsentMessage(variant), null, variant);
});

test("service credentials bind deployment and host, expire, and revoke", t => {
  const dir = mkdtempSync(join(tmpdir(), "app-credentials-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new AppCredentials(join(dir, "access"));
  const { credential, token } = store.issue({ deployment: "staging", host: "Platform.Test", label: "staging app", days: 30 }, NOW);
  assert.match(token, /^tap_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  assert.equal((statSync(join(dir, "access", "credentials")).mode & 0o077), 0);
  assert.ok(!readFileSync(join(dir, "access", "credentials", `${credential.id}.json`), "utf8").includes(token.split(".")[1]!), "only the hash is stored");
  assert.equal(store.authenticate(`Bearer ${token}`, HOST, NOW)?.deployment, "staging");
  assert.equal(store.authenticate(`Bearer ${token}`, "other.test", NOW), null);
  assert.equal(store.authenticate(`Bearer ${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`, HOST, NOW), null, "a changed secret");
  assert.equal(store.authenticate(`Bearer ${token}`, HOST, NOW + 30 * 86_400_000), null);
  assert.throws(() => store.issue({ deployment: "staging", host: HOST, label: "x", days: 366 }, NOW), BadRequest);
  assert.equal(store.revoke(credential.id), true);
  assert.equal(store.authenticate(`Bearer ${token}`, HOST, NOW), null);
});

test("a credential's hourly request limit is the operator's: set at issue or later, the default written nowhere (#15)", t => {
  const dir = mkdtempSync(join(tmpdir(), "app-credentials-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new AppCredentials(join(dir, "access"));
  const file = (id: string) => JSON.parse(readFileSync(join(dir, "access", "credentials", `${id}.json`), "utf8"));
  const plain = store.issue({ deployment: "staging", host: HOST, label: "staging", days: 30 }, NOW);
  assert.equal(plain.credential.perHour, DEFAULT_REQUESTS_PER_HOUR);
  assert.ok(!("perHour" in file(plain.credential.id)), "a credential at the default stores no limit, so its record stays as before");
  const set = store.issue({ deployment: "production", host: HOST, label: "production", days: 30, perHour: 6_000 }, NOW);
  assert.equal(file(set.credential.id).perHour, 6_000);
  assert.equal(store.authenticate(`Bearer ${set.token}`, HOST, NOW)?.perHour, 6_000);
  for (const perHour of [0, -1, 1.5, MAX_REQUESTS_PER_HOUR + 1, Number.NaN])
    assert.throws(() => store.issue({ deployment: "staging", host: HOST, label: "x", days: 30, perHour }, NOW), BadRequest, String(perHour));
  // Changed in place: the token stays the same, and the next call reads the new limit.
  assert.equal(store.limit(plain.credential.id, 60), true);
  assert.equal(store.authenticate(`Bearer ${plain.token}`, HOST, NOW)?.perHour, 60);
  assert.equal(store.limit(set.credential.id, DEFAULT_REQUESTS_PER_HOUR), true);
  assert.ok(!("perHour" in file(set.credential.id)), "back at the default, the record stores none");
  assert.throws(() => store.limit(plain.credential.id, MAX_REQUESTS_PER_HOUR + 1), BadRequest);
  assert.equal(store.limit("00000000-0000-4000-8000-000000000000", 60), false);
});

test("the hourly limiter takes each call's limit, and a lowered one waits until enough requests leave the hour", () => {
  const allow = hourlyLimit(5), hour = 3_600_000;
  for (let i = 0; i < 5; i++) assert.equal(allow("k", NOW + i * 1_000), true);
  assert.equal(allow("k", NOW + 5_000), false);
  assert.equal(allow.retryAfterSeconds("k", NOW + 5_000), (hour - 5_000) / 1_000, "the oldest leaves first");
  // Lowered to 2 with 5 in the hour: 4 must leave, so the 4th oldest (at +3 s) decides.
  assert.equal(allow("k", NOW + 5_000, 2), false);
  assert.equal(allow.retryAfterSeconds("k", NOW + 5_000, 2), (hour + 3_000 - 5_000) / 1_000);
  assert.equal(allow("k", NOW + hour + 3_000, 2), true, "at that moment one remains, so one more fits");
  assert.equal(allow("k", NOW + hour + 3_000, 2), false);
  // Raised: more fit at once.
  assert.equal(allow("k", NOW + hour + 3_000, 10), true);
  assert.equal(allow.retryAfterSeconds("k", NOW + hour + 3_000, 10), 0);
});

test("a signed consent is verified against this host, the calling deployment, expiry and the owner's full-access key", async () => {
  const expected = { host: HOST, deployment: "staging" };
  const good = await signed(consentMessage(fields()));
  const verified = await verifyConsent(good, expected, fullAccess);
  assert.deepEqual([verified.owner, verified.agent, verified.organization, verified.scopes], ["owner.near", "payout", "org_1", ["read"]]);
  await refusal(verifyConsent(await signed(consentMessage(fields({ host: "other.test" })), "owner.near", "other.test"), expected, fullAccess), /another platform host/);
  await refusal(verifyConsent(await signed(consentMessage(fields({ deployment: "production" }))), expected, fullAccess), /another app deployment/);
  await refusal(verifyConsent(await signed(consentMessage(fields({ expiresAt: later(0.0001) }))), expected, fullAccess), /expired/);
  await refusal(verifyConsent(await signed(consentMessage(fields({ expiresAt: later(400) }))), expected, fullAccess), /at most/);
  await refusal(verifyConsent({ ...good, message: consentMessage(fields({ organization: "org_2" })) }, expected, fullAccess), /signature doesn't match/);
  await refusal(verifyConsent(await signed(consentMessage(fields()), "owner.near", "other.test"), expected, fullAccess), /signature doesn't match/);
  await refusal(verifyConsent({ ...good, nonce: randomBytes(16).toString("base64") }, expected, fullAccess), /32 bytes/);
  await refusal(verifyConsent(good, expected, async () => "FunctionCall"), /not a full-access key/);
  await refusal(verifyConsent(good, expected, async () => null), /not a full-access key/);
  await assert.rejects(verifyConsent(good, expected, async () => { throw new Error("rpc down"); }), (error: unknown) =>
    error instanceof Error && !(error instanceof BadRequest) && /rpc down/.test(error.message), "an unanswered lookup is not a refusal");
  await refusal(verifyConsent({ message: "x" }, expected, fullAccess), /Send the signed consent/);
});

test("a consent is stored once by signature; a revocation is permanent, survives its record, and binds the host", async t => {
  const dir = mkdtempSync(join(tmpdir(), "app-consents-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new AppConsents(dir);
  const verified = await verifyConsent(await signed(consentMessage(fields())), { host: HOST, deployment: "staging" }, fullAccess);
  const first = store.store(verified);
  assert.equal(store.store(verified).createdAt, first.createdAt);
  assert.equal(store.revoke(first.id, { deployment: "production", host: HOST }), false, "another deployment can't revoke it");
  assert.equal(store.revoke(first.id, { deployment: "staging", host: "other.test" }), false, "nor the same deployment on another host");
  assert.equal(store.revoke(first.id, { deployment: "staging", host: HOST }), true);
  assert.throws(() => store.store(verified), /revoked/);
  assert.deepEqual(store.live({ deployment: "staging", host: HOST, organization: "org_1", agent: "payout" }), []);
  // Archiving the record doesn't bring the signature back.
  rmSync(join(dir, "consents", `${first.id}.json`));
  assert.throws(() => store.store(verified), /revoked/);
  // The operator can revoke a consent whose record is already gone, before anyone resubmits it.
  const other = await verifyConsent(await signed(consentMessage(fields({ organization: "org_2" }))), { host: HOST, deployment: "staging" }, fullAccess);
  assert.equal(store.revoke(other.id, null), true);
  assert.throws(() => store.store(other), /revoked/);
});

const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
const close = (server: Server) => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
function call(port: number, path: string, method = "GET", token?: string, body?: object, headers = {}) {
  return new Promise<{ status: number; body: any; headers: import("node:http").IncomingHttpHeaders }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { ...headers, ...(token && { authorization: `Bearer ${token}` }), "content-type": "application/json" } }, res => {
      let text = ""; res.on("data", chunk => text += chunk); res.on("end", () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : null, headers: res.headers }));
    }); req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}

/** A gateway serving only `appRoutes`, an agent server that records what reaches it, and mocked chain/provider reads. */
async function routeHarness(t: import("node:test").TestContext) {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "app-routes-")); process.chdir(dir);
  const state = { providerId: "provider-id" as string | null, dao: false, keys: (async () => "FullAccess") as KeyStateLookup,
    setup: undefined as HostedSetup | undefined, agentDown: false, stopping: false, reply: { status: 200, body: '{"json":{"ok":true}}' } };
  const forwarded: { headers: Record<string, unknown>; path: string; body: string }[] = [];
  const upstream = createServer((req, res) => { let body = ""; req.on("data", chunk => body += chunk); req.on("end", () => {
    forwarded.push({ headers: req.headers, path: req.url!, body }); res.writeHead(state.reply.status, { "content-type": "application/json" }); res.end(state.reply.body);
  }); });
  const agent = { name: "payout", owner: "owner.near", port: await listen(upstream), area: "payables" as const, executor: true };
  writeFileSync(join(dir, "confirm.html"), "<!doctype html><title>Confirm</title>");
  const server = createServer(async (req, res) => { try {
    if (await confirmRoutes(req, res, new URL(req.url!, "http://x").pathname, HOST, confirms, APP_ROOT, [agent], dir, () => state.stopping)) return;
    if (!await appRoutes(req, res, new URL(req.url!, "http://x").pathname, HOST, [agent], () => state.stopping,
      { keyState: (account, key) => state.keys(account, key), nonceSecret: "c".repeat(32), ...(state.setup && { setup: state.setup }) })) { res.writeHead(404); res.end("{}"); }
  } catch (e) { sendFailure(res, e); } });
  const port = await listen(server);
  t.after(async () => { await close(server); await close(upstream); process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); });
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname.startsWith("/rpc/") && state.agentDown) return new Response("down", { status: 503 });
    if (url.pathname.startsWith("/rpc/")) return Response.json({ json: state.providerId === null ? { agentId: null, owner: null }
      : { agentId: state.providerId, owner: { type: "near", account_id: agent.owner } } });
    if (state.dao) return Response.json({ jsonrpc: "2.0", id: 1, result: { block_hash: "5f8R8jZuPxPXMKk7ghU8ZtMJdAfqgRqfxHP2Ke7F3rC7", block_height: 219835073, logs: [],
      result: [...Buffer.from(JSON.stringify({ roles: [], default_vote_policy: {}, proposal_bond: "0", proposal_period: "0", bounty_bond: "0", bounty_forgiveness_period: "0" }))] } });
    return Response.json({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: agent.owner } }, code: -32000, message: "Server error" } });
  });
  const credentials = new AppCredentials(".app-access");
  const staging = credentials.issue({ deployment: "staging", host: HOST, label: "staging", days: 30 }).token;
  const production = credentials.issue({ deployment: "production", host: HOST, label: "production", days: 30 }).token;
  const rpc = (org: string, procedure: string) => `/apps/v1/o/${org}/a/payout/rpc/${procedure}`;
  const consent = async (over = {}) => call(port, "/apps/v1/consents", "POST", staging, await signed(consentMessage(fields(over))));
  return { port, state, forwarded, agent, staging, production, rpc, consent };
}

/** A refusal's status, `code` and `access`, which an app decides by. */
const denial = (answer: { status: number; body: { code?: string; access?: string } }) => [answer.status, answer.body.code, answer.body.access];

test("the app route needs the deployment's credential and a live owner consent, re-checks ownership, and forwards only reads", async t => {
  const { port, state, forwarded, agent, staging, production, rpc, consent } = await routeHarness(t);
  assert.equal((await call(port, rpc("org_1", "overview"), "POST", undefined, {})).status, 401);
  assert.deepEqual(denial(await call(port, rpc("org_1", "overview"), "POST", staging, {})), [403, "no_consent", "agent"], "no consent yet");

  const identity = await call(port, "/apps/v1/agents/payout", "GET", staging);
  assert.deepEqual(identity.body, { agent: "payout", owner: "owner.near", agentId: "provider-id", created: true, host: HOST, deployment: "staging", signer: "wallet" });
  assert.equal((await call(port, "/apps/v1/agents/payout", "GET")).status, 401);
  assert.deepEqual(denial(await consent({ agentId: "earlier-agent" })), [409, "agent_changed", undefined], "a consent signed for another agent identity isn't attached to this one");
  const stored = await consent();
  assert.equal(stored.status, 201, JSON.stringify(stored.body));
  assert.equal(stored.body.consent.signature, undefined);
  assert.equal(stored.body.consent.agentId, "provider-id");

  const read = await call(port, rpc("org_1", "overview"), "POST", staging, { json: null }, { "x-gateway-actor": "forged", "x-gateway": "forged" });
  assert.equal(read.status, 200);
  assert.equal(forwarded.at(-1)!.path, "/rpc/overview");
  assert.equal(forwarded.at(-1)!.headers.authorization, undefined);
  assert.equal(forwarded.at(-1)!.headers["x-gateway-actor"], "app:staging:org_1");
  assert.equal(forwarded.at(-1)!.headers["x-gateway"], undefined);
  const before = forwarded.length;
  assert.equal((await call(port, rpc("org_1", "overview"), "POST", staging, {}, { origin: "https://evil.test" })).status, 403, "browser origin");
  assert.equal((await call(port, rpc("org_1", "overview"), "POST", staging, {}, { cookie: "s=1" })).status, 403, "browser cookie");
  assert.equal(forwarded.length, before, "nothing forwarded for a browser request");
  for (const procedure of ["owner/prepare", "owner/submit", "sweep", "compensation/list", "workOrders/list", "agreements/list", "strategy/get", "pay"])
    assert.deepEqual(denial(await call(port, rpc("org_1", procedure), "POST", staging, {})), [403, procedure === "owner/prepare" ? "not_allowed" : "scope", "procedure"], procedure);
  assert.equal((await call(port, rpc("org_2", "overview"), "POST", staging, {})).status, 403, "another Organization");
  assert.equal((await call(port, rpc("org_1", "overview"), "POST", production, {})).status, 403, "another deployment");
  assert.equal((await call(port, "/apps/v1/consents?organization=org_1", "GET", production)).body.consents.length, 0);
  assert.equal((await call(port, `/apps/v1/consents/${stored.body.consent.id}`, "DELETE", production)).status, 404);

  state.keys = async () => { throw new Error("rpc down"); };
  assert.equal((await call(port, rpc("org_1", "overview"), "POST", staging, {})).status, 503, "an unanswered key check refuses the call");
  state.keys = async () => "FullAccess";
  assert.equal((await call(port, rpc("org_1", "overview"), "POST", staging, {})).status, 200, "and revokes nothing");

  state.providerId = "replacement";
  assert.deepEqual(denial(await call(port, rpc("org_1", "overview"), "POST", staging, {})), [403, "agent_changed", "agent"], "a replaced agent isn't covered");
  state.providerId = "provider-id";

  const otherOwner = await call(port, "/apps/v1/consents", "POST", staging, await signed(consentMessage(fields({ owner: "intruder.near" })), "intruder.near"));
  assert.deepEqual(denial(otherOwner), [403, "not_owner", undefined], "only the configured owner can consent");

  state.dao = true;
  assert.ok(await daoPolicy(agent.owner), "the mocked chain answers as a Sputnik DAO");
  assert.equal((await consent({ organization: "org_3" })).status, 409);
  state.dao = false;

  assert.equal((await call(port, `/apps/v1/consents/${stored.body.consent.id}`, "DELETE", staging)).status, 200);
  assert.deepEqual(denial(await call(port, rpc("org_1", "overview"), "POST", staging, {})), [403, "no_consent", "agent"], "revoked");
  const calls = accessLogText().trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(calls.map(c => c.event), ["consent", "call", "call", "revoke"], "refused calls are not logged as calls");
  assert.equal(calls[1].path, "overview");
});

test("an owner consent lets the app prepare and submit wallet-signed owner actions, and nothing else", async t => {
  const { port, state, forwarded, staging, rpc, consent } = await routeHarness(t);
  const prepare = (signer: string) => call(port, rpc("org_1", "owner/prepare"), "POST", staging, { json: { action: { type: "agent_freeze" }, signer } });
  state.reply.body = preparedReply("nep413");
  assert.equal((await consent({ scopes: ["owner"] })).status, 201);
  assert.equal((await prepare("wallet")).status, 200);
  assert.equal(forwarded.at(-1)!.path, "/rpc/owner/prepare");
  assert.equal((await call(port, rpc("org_1", "owner/submit"), "POST", staging, { json: { correlationId: "c", signedData: {} } })).status, 200);
  assert.equal((await call(port, rpc("org_1", "owner/status"), "POST", staging, { json: { correlationId: "c" } })).status, 200);
  const before = forwarded.length;
  assert.equal((await prepare("dao")).status, 403, "only the owner's own wallet signs through the app");
  assert.equal((await call(port, rpc("org_1", "owner/prepare"), "POST", staging, { json: { action: { type: "agent_freeze" } } })).status, 403, "the signer must be stated");
  assert.equal((await call(port, rpc("org_1", "owner/prepare"), "POST", staging, {})).status, 403, "an unreadable body is refused");
  for (const procedure of ["overview", "workOrders/submit", "compensation/send", "pay", "sweep"])
    assert.equal((await call(port, rpc("org_1", procedure), "POST", staging, {})).status, 403, `${procedure}: owner scope reads and sends nothing else`);
  assert.equal(forwarded.length, before, "nothing refused was forwarded");
});

test("the app prepares the owner actions an app may ask for; a readable intent reaches it, a NEP-366 one becomes a confirm link", async t => {
  const { port, state, forwarded, staging, rpc, consent } = await routeHarness(t);
  const given = await consent({ scopes: ["owner"] });
  assert.equal(given.status, 201);
  const owner = (public_key = given.body.consent.publicKey) => ({ type: "near", account_id: "owner.near", public_key });
  const prepare = (action: object, meta?: unknown[]) => call(port, rpc("org_1", "owner/prepare"), "POST", staging, { json: { action, signer: "wallet" }, ...(meta && { meta }) });
  const expectedPolicy = { revision: 3, digest: `sha256:${"0".repeat(64)}` };
  const edit = (changes: object) => ({ type: "policy_update", expectedPolicy, changes });

  state.reply.body = preparedReply("nep413");
  for (const action of [{ type: "agent_create", owner: owner() }, { type: "agent_create", owner: owner(), role: "payout", payees: [] }, { type: "agent_freeze" }, { type: "agent_unfreeze" },
    { type: "agent_archive" }, { type: "agent_restore" }, { type: "grant_issue", label: "payout" }, { type: "grant_revoke", grantId: "g" },
    edit({ destinations: [{ address: "payee.near", confidential: true }] }), edit({ budget: { daily_usd: "10", weekly_usd: null, monthly_usd: null } }),
    edit({ swap: true }), edit({ assets: "any" }), edit({ owner_approval: false }), edit({ max_actions_per_hour: 100 }), edit({ limits: { daily: { usdc: "1" } } }),
    { type: "approval_vote", approvalId: crypto.randomUUID(), verdict: "approve", correlationId: "c" }])
    assert.equal((await prepare(action)).status, 200, JSON.stringify(action));
  assert.equal((await prepare(edit({ budget: { daily_usd: "10", weekly_usd: null, monthly_usd: null }, swap: null }), [["undefined", "action", "changes", "swap"]])).status, 200,
    "serializer metadata is read as the agent server reads it: undefined leaves a field unchanged");
  const readable = await prepare(edit({ owner_approval: false }));
  assert.deepEqual(readable.body, JSON.parse(state.reply.body), "a readable intent is released unchanged");

  const before = forwarded.length;
  for (const action of [{ type: "agent_create", owner: owner(), payees: ["payee.near"] }, { type: "agent_create" },
    { type: "agent_create", owner: owner(`ed25519:${"1".repeat(44)}`) }, { type: "agent_delete" }])
    assert.equal((await prepare(action)).status, 403, JSON.stringify(action));
  assert.equal((await prepare(edit({}), [["date", "action", "changes", "assets"]])).status, 403, "metadata naming a field that isn't there is refused");
  assert.equal(forwarded.length, before, "nothing refused was forwarded");

  for (const [action, id] of [[edit({ owner_approval: false }), "c-edit"], [{ type: "agent_freeze" }, "c-freeze"], [{ type: "agent_create", owner: owner(), role: "payout" }, "c-create"]] as const) {
    state.reply.body = preparedReply("nep366", id);
    const held = await prepare(action);
    assert.equal(held.status, 200, JSON.stringify(action));
    assert.equal(held.body.json.correlationId, id);
    assert.match(held.body.json.confirm.url, new RegExp(`^https://${HOST}/confirm/[A-Za-z0-9_-]{22}$`));
    assert.equal(held.body.json.intent, undefined, "the app never receives NEP-366 bytes");
    assert.equal(JSON.stringify(held.body).includes("outlayer.near"), false);
  }
  state.reply.body = preparedReply("eip712", "c-other");
  assert.equal((await prepare({ type: "agent_freeze" })).status, 403, "an intent the platform can't show the owner isn't released");
  state.reply = { status: 409, body: '{"json":{"defined":false,"code":"CONFLICT","status":409,"message":"open"}}' };
  assert.equal((await prepare(edit({}))).status, 409, "the agent's refusals pass through");
  state.reply = { status: 200, body: "not json" };
  assert.equal((await prepare(edit({}))).status, 502, "an unreadable reply isn't released");

  const log = accessLogText().trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(log.filter(l => ["confirm", "withheld"].includes(l.event)).map(l => [l.event, l.action, l.correlationId]),
    [["confirm", "policy_update", "c-edit"], ["confirm", "agent_freeze", "c-freeze"], ["confirm", "agent_create", "c-create"], ["withheld", "agent_freeze", "c-other"]]);
});

/** A POST whose body arrives `delay` ms after its headers, so two can be read concurrently. */
function slowPost(port: number, path: string, body: object, delay: number) {
  return new Promise<number>((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(text) } },
      res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
    req.on("error", reject); req.flushHeaders(); setTimeout(() => req.end(text), delay);
  });
}
/** The owner key's NEP-413 signature over a link's opening text, as the page asks the wallet for it. */
async function openingSignature(opening: { message: string; recipient: string; nonce: string }, key = DELEGATE_KEY) {
  const near = new Near({ network: "mainnet", privateKey: key.secretKey as PrivateKey, defaultSignerId: "owner.near" });
  const signed = await near.signMessage({ message: opening.message, recipient: opening.recipient, nonce: Buffer.from(opening.nonce, "base64") });
  return { signature: signed.signature };
}

test("a confirm link shows the agent's record; the bytes go only to the owner's key, and only its signature over them submits, once", async t => {
  const { port, state, forwarded, staging, rpc, consent } = await routeHarness(t);
  assert.equal((await consent({ scopes: ["owner"] })).status, 201);
  const current = payoutPolicy(["payee.near"]), requested = { ...current, owner_approval: false };
  state.reply.body = preparedReply("nep366", "c-edit", undefined, { current, requested });
  const held = await call(port, rpc("org_1", "owner/prepare"), "POST", staging,
    { json: { action: { type: "policy_update", expectedPolicy: { revision: 3, digest: `sha256:${"0".repeat(64)}` }, changes: { owner_approval: false } }, signer: "wallet" } });
  const path = new URL(held.body.json.confirm.url).pathname, api = path.replace("/confirm/", "/confirm/v1/");
  assert.equal(await (await httpFetch(`http://127.0.0.1:${port}${path}`)).text(), "<!doctype html><title>Confirm</title>", "the page is the platform's own");

  // Anyone holding the link, the app included, reads the terms but not the bytes to sign.
  const view = await call(port, api);
  assert.deepEqual([view.status, view.body.deployment, view.body.organization, view.body.agent, view.body.type, view.body.policy, view.body.state],
    [200, "staging", "org_1", "payout", "policy_update", { current, requested }, "open"]);
  assert.equal(view.body.intent, undefined);
  assert.equal(JSON.stringify(view.body).includes("outlayer.near"), false);
  const lines = view.body.opening.message.split("\n");
  assert.equal(lines[0], "Open a MultiAgency confirm page.");
  assert.match(lines[1], new RegExp(`^Sign this only on https://${HOST}/confirm/\\. If any other page asks you to sign it, refuse`), "the wallet shows the warning");
  assert.deepEqual(lines.slice(3), ["App deployment: staging", "Organization: org_1", "Agent: payout", "Action: policy_update", `Expires: ${view.body.expiresAt}`]);
  assert.equal(view.body.opening.recipient, HOST);

  const before = forwarded.length;
  const viaApp = await call(port, rpc("org_1", "owner/submit"), "POST", staging, { json: { correlationId: "c-edit", signedData: signDelegate() } });
  assert.equal(viaApp.status, 403, "the app can't submit an action held for the confirm page");
  assert.equal((await call(port, `${api}/open`, "POST", undefined, await openingSignature(view.body.opening, generateKey()))).status, 403, "another key doesn't open it");
  assert.equal((await call(port, `${api}/open`, "POST", undefined, await openingSignature({ ...view.body.opening, message: "{}" }))).status, 403,
    "nor the owner's signature over another text");
  const opened = await call(port, `${api}/open`, "POST", undefined, await openingSignature(view.body.opening));
  assert.deepEqual([opened.status, opened.body.intent], [200, DELEGATE_INTENT], "the owner's signature over the link's text releases the bytes");

  const submit = (signedData: object) => call(port, api, "POST", undefined, { signedData });
  assert.equal((await submit(signDelegate({ methodName: "unfreeze_wallet" }))).status, 400, "a signature over other bytes is refused here");
  assert.equal((await submit(signDelegate({ signer: generateKey() }))).status, 400, "so is another key's");
  assert.equal(forwarded.length, before, "nothing reached the agent");
  assert.equal((await call(port, api)).body.state, "open", "and the link stays usable");

  state.reply.body = JSON.stringify({ json: { status: "SUCCESS" } });
  const statuses = await Promise.all([slowPost(port, api, { signedData: signDelegate() }, 100), slowPost(port, api, { signedData: signDelegate() }, 150)]);
  assert.deepEqual(statuses.sort(), [200, 409], "two submissions read together: one is forwarded");
  const submits = forwarded.slice(before).filter(f => f.path === "/rpc/owner/submit");
  assert.equal(submits.length, 1);
  assert.equal(submits[0]!.headers["x-gateway-actor"], "app:staging:org_1");
  assert.equal(JSON.parse(submits[0]!.body).json.correlationId, "c-edit");
  const again = await submit(signDelegate());
  assert.deepEqual([again.status, again.body.error], [409, "A submission was already made from this link. The app follows its outcome; if it failed, the app prepares the action again."]);
  assert.equal((await call(port, `${api}/open`, "POST", undefined, await openingSignature(view.body.opening))).status, 409, "a used link releases nothing more");
  assert.equal((await call(port, api)).body.state, "submitted");

  state.reply.body = JSON.stringify({ json: { status: "SUCCESS" } });
  assert.equal((await call(port, rpc("org_1", "owner/submit"), "POST", staging, { json: { correlationId: "c-readable", signedData: {} } })).status, 200,
    "an action not held here is the app's to submit");
  assert.equal((await call(port, "/confirm/v1/AAAAAAAAAAAAAAAAAAAAAA")).status, 404);
  writeFileSync(join(".app-access", "confirm", `${"0".repeat(64)}.json`), "{not json");
  assert.equal((await call(port, rpc("org_1", "owner/submit"), "POST", staging, { json: { correlationId: "c-other", signedData: {} } })).status, 200,
    "an unreadable confirm record doesn't stop other submissions");
  assert.equal((await call(port, rpc("org_1", "owner/submit"), "POST", staging, { json: { correlationId: "c-edit", signedData: signDelegate() } })).status, 403,
    "and a held action stays refused");
  state.reply.body = preparedReply("nep366", "c-late", new Date(Date.now() - 1000).toISOString());
  const late = await call(port, rpc("org_1", "owner/prepare"), "POST", staging, { json: { action: { type: "agent_freeze" }, signer: "wallet" } });
  const lateApi = new URL(late.body.json.confirm.url).pathname.replace("/confirm/", "/confirm/v1/");
  const lateView = await call(port, lateApi);
  assert.deepEqual([lateView.body.state, lateView.body.policy], ["expired", null]);
  assert.equal((await call(port, `${lateApi}/open`, "POST", undefined, await openingSignature(lateView.body.opening))).status, 410);
  assert.equal((await call(port, lateApi, "POST", undefined, { signedData: signDelegate() })).status, 410);
  const log = accessLogText().trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(log.filter(l => l.event === "confirmed").map(l => l.correlationId), ["c-edit"]);
});

/** A prepared vote on held payout `held` as the agent answers it: the provider's `approve:` text and the terms the agent proved. */
const VOTE_PAYLOAD = { message: `approve:a-1:ed25519:wallet:${"ab".repeat(32)}`, recipient: "outlayer.near", nonce: randomBytes(32).toString("base64") };
const voteReply = (correlationId: string, payment: { correlationId: string; verdict: string; terms: object | null }) => JSON.stringify({ json: { correlationId,
  preview: { summary: "Approve" }, expiresAt: later(0.005), digest: null, payment,
  signer: { type: "near", account_id: "owner.near", public_key: DELEGATE_KEY.publicKey.toString() }, intent: { standard: "nep413", payload: VOTE_PAYLOAD } } });
/** The owner's wallet signing the vote's text, as the page's `signIntent` returns it. */
async function signVote(key = DELEGATE_KEY, payload = VOTE_PAYLOAD) {
  const near = new Near({ network: "mainnet", privateKey: key.secretKey as PrivateKey, defaultSignerId: "owner.near" });
  const signed = await near.signMessage({ ...payload, nonce: Buffer.from(payload.nonce, "base64") });
  return { standard: "nep413", payload, public_key: signed.publicKey, signature: signed.signature };
}

test("a vote on a held payout gets a confirm link showing the terms the agent proved, beside the text the app keeps (#48)", async t => {
  const { port, state, forwarded, staging, rpc, consent } = await routeHarness(t);
  assert.equal((await consent({ scopes: ["owner"] })).status, 201);
  const terms = { recipient: "payee.near", asset: "nep141:usdc.near", amount: "2500000" };
  const vote = (correlationId = "held-1", verdict = "approve") => call(port, rpc("org_1", "owner/prepare"), "POST", staging,
    { json: { action: { type: "approval_vote", approvalId: "6f1c2a4e-0b7d-4c1e-9a3f-2d5e8b7c1a90", verdict, correlationId }, signer: "wallet" } });
  const viewOf = async (answer: { body: any }) => {
    const api = new URL(answer.body.json.confirm.url).pathname.replace("/confirm/", "/confirm/v1/");
    return { api, view: await call(port, api) };
  };

  // The app gets the text to sign, as before, and a link to the platform's page beside it.
  state.reply.body = voteReply("c-vote", { correlationId: "held-1", verdict: "approve", terms });
  const offered = await vote();
  assert.equal(offered.status, 200, JSON.stringify(offered.body));
  assert.deepEqual(offered.body.json.intent, { standard: "nep413", payload: VOTE_PAYLOAD }, "the readable text still reaches the app");
  assert.match(offered.body.json.confirm.url, new RegExp(`^https://${HOST}/confirm/[A-Za-z0-9_-]{22}$`));
  const { api, view } = await viewOf(offered);
  assert.deepEqual([view.status, view.body.type, view.body.payment, view.body.intent, view.body.opening, view.body.state],
    [200, "approval_vote", { correlationId: "held-1", verdict: "approve", terms }, { standard: "nep413", payload: VOTE_PAYLOAD }, undefined, "open"],
    "the page shows the agent's proven terms, and the text the app already holds, with no opening step");
  assert.equal((await call(port, `${api}/open`, "POST", undefined, await openingSignature({ message: "", recipient: HOST, nonce: VOTE_PAYLOAD.nonce }))).status, 404,
    "a vote's link has nothing to open");
  const submit = async (signedData: object) => call(port, api, "POST", undefined, { signedData });
  const before = forwarded.length;
  assert.equal((await submit(await signVote(generateKey()))).status, 400, "another key's signature is refused on the page");
  assert.equal((await submit(await signVote(DELEGATE_KEY, { ...VOTE_PAYLOAD, message: "approve:a-2:x:y" }))).status, 400, "so is a signature over another text");
  assert.equal(forwarded.length, before, "nothing reached the agent");
  state.reply.body = JSON.stringify({ json: { status: "PENDING" } });
  assert.equal((await submit(await signVote())).status, 200);
  const sent = forwarded.slice(before);
  assert.deepEqual(sent.map(f => [f.path, JSON.parse(f.body).json.correlationId, f.headers["x-gateway-actor"]]), [["/rpc/owner/submit", "c-vote", "app:staging:org_1"]],
    "the page's submission is the agent's own owner/submit, under the app's actor");
  assert.equal((await submit(await signVote())).status, 409, "a link submits once");
  assert.equal((await call(port, rpc("org_1", "owner/submit"), "POST", staging, { json: { correlationId: "c-vote", signedData: await signVote() } })).status, 200,
    "an offered link holds nothing: the app may submit too, and the agent answers a repeat from its record");

  // Terms the agent didn't prove for the payout and verdict the app asked about make no page.
  for (const [payment, asked] of [[{ correlationId: "held-2", verdict: "approve", terms }, ["held-1", "approve"]],
    [{ correlationId: "held-1", verdict: "approve", terms }, ["held-1", "reject"]], [{ correlationId: "held-1", verdict: "approve", terms: null }, ["held-1", "approve"]]] as const) {
    state.reply.body = voteReply("c-odd", payment);
    const odd = await vote(...asked);
    assert.deepEqual([odd.status, odd.body.json.confirm, odd.body.json.intent?.standard], [200, undefined, "nep413"], JSON.stringify(payment));
  }
  state.reply.body = voteReply("c-reject", { correlationId: "held-1", verdict: "reject", terms: null });
  const rejecting = await vote("held-1", "reject");
  assert.deepEqual((await viewOf(rejecting)).view.body.payment, { correlationId: "held-1", verdict: "reject", terms: null }, "a reject releases nothing, and says so");

  const log = accessLogText().trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(log.filter(l => ["confirm", "confirmed", "withheld"].includes(l.event)).map(l => [l.event, l.correlationId]),
    [["confirm", "c-vote"], ["confirmed", "c-vote"], ["confirm", "c-reject"]]);
});

/** The harness mocks global fetch for chain and provider reads, so the client reaches the gateway over node:http. */
const httpFetch = ((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
  const url = new URL(input instanceof Request ? input.url : input);
  const req = request(url, { method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers)) }, res => {
    const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk));
    res.on("end", () => resolve(new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), { status: res.statusCode!, headers: res.headers as HeadersInit })));
  }); req.on("error", reject); req.end(typeof init?.body === "string" ? init.body : undefined);
})) as typeof fetch;

test("the app client reaches its routes with the deployment credential and keeps the owner client's result kinds", async t => {
  const { port, state, forwarded, staging } = await routeHarness(t);
  const base = `http://127.0.0.1:${port}` as const;
  const client = appClient({ base, credential: staging, fetch: httpFetch });
  const identity = await client.identity("payout");
  assert.deepEqual(identity.ok && [identity.value.agentId, identity.value.created, identity.value.deployment], ["provider-id", true, "staging"]);
  assert.deepEqual(await appClient({ base, credential: "tap_00000000-0000-4000-8000-000000000000.x", fetch: httpFetch }).identity("payout"),
    { ok: false, kind: "session", status: 401, error: "Invalid, expired or revoked app credential" });
  const noSetup = await client.setup(await signed(setupMessage(setupFields())));
  assert.deepEqual(noSetup.ok === false && [noSetup.kind, "status" in noSetup && noSetup.status, "code" in noSetup && noSetup.code], ["forbidden", 403, "setup_unavailable"], "no setup on this host");

  const body = await signed(consentMessage(fields({ scopes: ["owner", "read"] })));
  const stored = await client.consents.submit(body);
  assert.ok(stored.ok);
  const again = await client.consents.submit(body);
  assert.equal(again.ok && again.value.consent.id, stored.value.consent.id, "the same signed consent is stored once");
  const listed = await client.consents.list("org_1");
  assert.deepEqual(listed.ok && listed.value.consents.map(c => [c.id, "signature" in c]), [[stored.value.consent.id, false]]);
  const forged = await client.consents.submit({ ...body, message: body.message.replace('"org_1"', '"org_2"') });
  assert.deepEqual(forged.ok === false && [forged.kind, "status" in forged && forged.status, "code" in forged && forged.code], ["refused", 400, "signature_invalid"], "a text other than the one signed");

  const payout = client.agent("org_1", "payout");
  state.reply.body = JSON.stringify({ json: { stage: "submitted", status: "SUCCESS" } });
  assert.deepEqual(await payout.call("owner/status", { correlationId: "c" }), { ok: true, value: { stage: "submitted", status: "SUCCESS" } });
  assert.equal(forwarded.at(-1)!.headers["x-gateway-actor"], "app:staging:org_1");
  assert.equal(forwarded.at(-1)!.headers.authorization, undefined, "the credential never reaches the agent");
  const expectedPolicy = { revision: 3, digest: `sha256:${"0".repeat(64)}` };
  state.reply.body = preparedReply("nep413");
  const readable = await payout.call("owner/prepare", { action: { type: "policy_update", expectedPolicy, changes: { budget: { daily_usd: "5", weekly_usd: null, monthly_usd: null } } }, signer: "wallet" });
  assert.equal(readable.ok && readable.value.intent?.standard, "nep413");
  assert.ok(readable.ok && isWalletPrepared(readable.value) && !isDaoPrepared(readable.value), "a wallet's answer narrows to the wallet's");
  state.reply.body = preparedReply("nep366");
  const held = await payout.call("owner/prepare", { action: { type: "policy_update", expectedPolicy, changes: { owner_approval: false } }, signer: "wallet" });
  assert.ok(held.ok && held.value.confirm && held.value.intent === undefined, "a NEP-366 intent answers a confirm link, typed, without its bytes");
  const before = forwarded.length;
  // @ts-expect-error an app may not ask for payees at creation; the gateway refuses it too
  const payees = await payout.call("owner/prepare", { action: { type: "agent_create", owner: { type: "near", account_id: "owner.near", public_key: "k" }, payees: ["p.near"] }, signer: "wallet" });
  assert.deepEqual(payees.ok === false && payees.kind === "forbidden" && [payees.source, payees.scope, payees.code], ["gateway", "procedure", "not_allowed"]);
  assert.equal(forwarded.length, before);
  // @ts-expect-error `pay` is not an app procedure
  void (() => payout.call("pay", {}));

  assert.ok((await client.consents.revoke(stored.value.consent.id)).ok);
  assert.ok((await client.consents.revoke(stored.value.consent.id)).ok, "revoking again is harmless");
  const revoked = await payout.call("owner/status", { correlationId: "c" });
  assert.deepEqual(revoked.ok === false && revoked.kind === "forbidden" && [revoked.scope, revoked.code], ["agent", "no_consent"], "a revoked consent reaches nothing");
});

test("an agent an app set up is reachable only by that deployment and Organization, whatever consent is signed", async t => {
  const { port, agent, staging, production, rpc, consent } = await routeHarness(t);
  const crossing = await consent({ organization: "org_2", scopes: ["read"] });
  assert.equal(crossing.status, 201, "stored while the agent had no scope");
  Object.assign(agent, { deployment: "staging", organization: "org_1" });
  assert.equal((await call(port, "/apps/v1/agents/payout", "GET", staging)).status, 200);
  assert.equal((await call(port, "/apps/v1/agents/payout", "GET", production)).status, 404, "another deployment doesn't see it");
  assert.equal((await consent({ organization: "org_3", scopes: ["read"] })).status, 403, "a consent for another Organization isn't stored");
  assert.equal((await consent({ scopes: ["read"] })).status, 201);
  assert.equal((await call(port, rpc("org_1", "overview"), "POST", staging, {})).status, 200);
  assert.equal((await call(port, rpc("org_2", "overview"), "POST", staging, {})).status, 403, "a consent signed for another Organization reaches nothing");
});

test("a payout consent reaches payout requests, their status, held payouts and a deposit address, and nothing else; other scopes don't reach requests", async t => {
  const { port, forwarded, staging, rpc, consent } = await routeHarness(t);
  const ask = { json: { requestId: "r-1", asset: "nep141:usdc", delivery: "intents", recipient: "payee.near", amount: "1", expectedPolicy: { revision: 1, digest: `sha256:${"0".repeat(64)}` } } };
  assert.equal((await consent({ scopes: ["owner", "read"] })).status, 201);
  assert.equal((await call(port, rpc("org_1", "payouts/request"), "POST", staging, ask)).status, 403, "read and owner scopes don't request payouts");
  assert.equal((await consent({ organization: "org_2", scopes: ["payout"] })).status, 201);
  assert.equal((await call(port, rpc("org_1", "deposit"), "POST", staging, {})).status, 403, "read and owner scopes don't take a deposit address");
  for (const procedure of ["payouts/request", "payouts/status", "held", "deposit"])
    assert.equal((await call(port, rpc("org_2", procedure), "POST", staging, procedure === "payouts/request" ? ask : { json: { requestId: "r-1" } })).status, 200, procedure);
  assert.equal(forwarded.at(-1)!.headers["x-gateway-actor"], "app:staging:org_2", "the agent namespaces requests by this actor");
  const before = forwarded.length;
  for (const procedure of ["pay", "overview", "owner/prepare", "compensation/send", "sweep"])
    assert.equal((await call(port, rpc("org_2", procedure), "POST", staging, {})).status, 403, `${procedure}: payout scope reaches nothing else`);
  assert.equal(forwarded.length, before);
});

test("a read consent follows the app's own payout requests by requestId, but never asks for one", async t => {
  const { port, forwarded, staging, production, rpc, consent } = await routeHarness(t);
  const ask = { json: { requestId: "r-1", asset: "nep141:usdc", delivery: "intents", recipient: "payee.near", amount: "1", expectedPolicy: { revision: 1, digest: `sha256:${"0".repeat(64)}` } } };
  assert.equal((await consent({ scopes: ["owner", "read"] })).status, 201);
  assert.equal((await call(port, rpc("org_1", "payouts/status"), "POST", staging, { json: { requestId: "r-1" } })).status, 200);
  assert.equal(forwarded.at(-1)!.path, "/rpc/payouts/status");
  assert.equal(forwarded.at(-1)!.headers["x-gateway-actor"], "app:staging:org_1", "answered for this deployment and Organization only, as under payout");
  const before = forwarded.length;
  assert.equal((await call(port, rpc("org_1", "payouts/request"), "POST", staging, ask)).status, 403, "read doesn't request payouts");
  assert.equal((await call(port, rpc("org_1", "deposit"), "POST", staging, {})).status, 403, "nor take a deposit address");
  assert.equal((await call(port, rpc("org_1", "payouts/status"), "POST", production, { json: { requestId: "r-1" } })).status, 403, "another deployment's credential reaches nothing");
  assert.equal(forwarded.length, before);
});

test("a treasury consent reaches proposals, bound to that consent and host; a relayed signature must be the owner's for this host", async t => {
  const { port, forwarded, staging, rpc, consent } = await routeHarness(t);
  const stored = (await consent({ scopes: ["treasury"] })).body.consent;
  const forged = { "x-gateway-consent": "f".repeat(64), "x-gateway-host": "evil.test", "x-gateway-consents": "f".repeat(64) };
  assert.equal((await call(port, rpc("org_1", "proposals/list"), "POST", staging, { json: null }, forged)).status, 200);
  assert.equal(forwarded.at(-1)!.headers["x-gateway-consent"], stored.id, "the consent the call came under, never the caller's");
  assert.equal(forwarded.at(-1)!.headers["x-gateway-host"], HOST);
  assert.equal(forwarded.at(-1)!.headers["x-gateway-consents"], stored.id, "this app's live treasury consents for the agent, never the caller's");
  // A second consent for the same agent and Organization (a renewal): both are live, so both are named.
  const second = (await consent({ scopes: ["treasury", "read"], expiresAt: later(120) })).body.consent;
  assert.equal((await call(port, rpc("org_1", "proposals/list"), "POST", staging, { json: null })).status, 200);
  assert.deepEqual(String(forwarded.at(-1)!.headers["x-gateway-consents"]).split(",").sort(), [stored.id, second.id].sort());
  assert.equal((await call(port, rpc("org_1", "strategy/get"), "POST", staging, { json: null }, forged)).status, 200);
  assert.equal(forwarded.at(-1)!.headers["x-gateway-consent"], undefined, "only proposal calls carry it");
  for (const procedure of ["executePlan", "externalPlan", "rebalance", "pay", "payouts/request"])
    assert.equal((await call(port, rpc("org_1", procedure), "POST", staging, {})).status, 403, `${procedure}: treasury alone doesn't reach it`);
  const before = forwarded.length;
  const relay = async (recipient: string) => call(port, rpc("org_1", "proposals/approve"), "POST", staging, { json: { id: "a".repeat(32), signed: await signed("text", "owner.near", recipient) } });
  assert.equal((await relay("other.test")).status, 400, "signed for another host");
  assert.equal(forwarded.length, before, "nothing forwarded");
  assert.equal((await relay(HOST)).status, 200);
  assert.equal(forwarded.at(-1)!.path, "/rpc/proposals/approve");
  assert.equal((await consent({ organization: "org_2", scopes: ["treasury", "treasury-execute"] })).status, 201);
  assert.equal((await call(port, rpc("org_2", "executePlan"), "POST", staging, { json: { planId: "00000000-0000-0000-0000-000000000000" } })).status, 200);
});

test("an unanswered ownership or key check is 503, never a refusal that would ask the owner to sign again", async t => {
  const { port, state, forwarded, staging, rpc, consent } = await routeHarness(t);
  assert.equal((await consent({ scopes: ["read"] })).status, 201);
  state.agentDown = true;
  assert.equal((await call(port, "/apps/v1/agents/payout", "GET", staging)).status, 503, "identity");
  assert.equal((await consent({ organization: "org_2", scopes: ["read"] })).status, 503, "consent");
  const before = forwarded.length;
  assert.equal((await call(port, rpc("org_1", "overview"), "POST", staging, {})).status, 503, "call");
  assert.equal(forwarded.length, before, "nothing forwarded");
  state.agentDown = false;
  state.keys = async () => { throw new Error("rpc timeout"); };
  assert.equal((await consent({ organization: "org_3", scopes: ["read"] })).status, 503, "an unanswered key lookup");
  assert.equal(existsSync(join(".app-access", "consents")) ? readdirSync(join(".app-access", "consents")).length : 0, 1, "nothing new stored");
});

test("a read consent can't prepare or submit owner actions", async t => {
  const { port, staging, rpc, consent } = await routeHarness(t);
  assert.equal((await consent()).status, 201);
  for (const procedure of ["owner/prepare", "owner/submit"])
    assert.equal((await call(port, rpc("org_1", procedure), "POST", staging, { json: { action: { type: "agent_freeze" }, signer: "wallet" } })).status, 403, procedure);
});

test("a setup for an agent that already exists is refused, so its stand-in consent never reads that agent", async t => {
  const { port, state, staging, rpc } = await routeHarness(t);
  const reserved: string[] = [];
  state.setup = async input => { reserved.push(input.owner); return { name: "payout", owner: input.owner, port: 0, area: input.area, executor: true }; };
  const setup = await call(port, "/apps/v1/setup", "POST", staging, await signed(setupMessage(setupFields())));
  assert.equal(setup.status, 409, JSON.stringify(setup.body));
  assert.equal(reserved.length, 1, "the existing reservation was found, nothing new reserved");
  assert.equal((await call(port, rpc("org_1", "owner/actions"), "POST", staging, {})).status, 403, "no consent was stored for it");
  state.providerId = null; state.agentDown = true;
  assert.equal((await call(port, "/apps/v1/setup", "POST", staging, await signed(setupMessage(setupFields())))).status, 503,
    "an existing agent that can't be read isn't assumed uncreated");
  assert.equal(existsSync(join(".app-access", "consents")) ? readdirSync(join(".app-access", "consents")).length : 0, 0);
});

const setupFields = (over: Partial<Parameters<typeof setupMessage>[0]> = {}) => ({ host: HOST, deployment: "staging", organization: "org_1",
  owner: "owner.near", area: "payables" as const, expiresAt: later(1 / 48), ...over });

test("a setup text is accepted only in its exact canonical form, and verified like a consent but for at most an hour", async () => {
  const text = setupMessage(setupFields());
  assert.equal(parseSetupMessage(text)?.area, "payables");
  for (const variant of [JSON.stringify(JSON.parse(text), null, 1), JSON.stringify({ ...JSON.parse(text), area: "invoices" }), text.replace('"owner"', '"Owner"')])
    assert.equal(parseSetupMessage(variant), null, variant);
  assert.equal(parseConsentMessage(text), null, "a setup text is never a consent");
  const expected = { host: HOST, deployment: "staging" };
  assert.equal((await verifySetup(await signed(text), expected, fullAccess)).setup.owner, "owner.near");
  await refusal(verifySetup(await signed(setupMessage(setupFields({ expiresAt: later(1 / 12) }))), expected, fullAccess), /at most an hour/);
  await refusal(verifySetup(await signed(setupMessage(setupFields({ deployment: "production" }))), expected, fullAccess), /another app deployment/);
  await refusal(verifySetup(await signed(consentMessage(fields())), expected, fullAccess), /isn't a canonical app setup/);
});

test("a signed setup reserves the owner's hosted agent and lets the app prepare its creation, only until it exists", async t => {
  const { port, state, staging, rpc } = await routeHarness(t);
  const post = async (body: object) => call(port, "/apps/v1/setup", "POST", staging, body);
  const body = await signed(setupMessage(setupFields()));
  assert.equal((await post(body)).status, 403, "no setup on a host without it");
  const reserved: { owner: string; area: string }[] = [];
  state.providerId = null;
  state.setup = async input => { reserved.push(input); return { name: "payout", owner: input.owner, port: 0, area: input.area, executor: true }; };
  state.dao = true;
  assert.equal((await post(body)).status, 409, "a DAO owner's setup goes to /apps/v1/dao-setups");
  state.dao = false;
  const done = await post(body);
  assert.equal(done.status, 201, JSON.stringify(done.body));
  assert.deepEqual(reserved, [{ owner: "owner.near", kind: "wallet", area: "payables", deployment: "staging", organization: "org_1" }], "the setup is scoped to its deployment and Organization");
  assert.deepEqual([done.body.agent, done.body.consent.agentId, done.body.consent.scopes], ["payout", "unborn", ["owner"]]);
  assert.equal(done.body.consent.signature, undefined);
  assert.equal((await post(body)).body.consent.id, done.body.consent.id, "the same signature sets up once");

  assert.deepEqual((await call(port, "/apps/v1/agents/payout", "GET", staging)).body.created, false);
  const create = (public_key = done.body.consent.publicKey) => ({ type: "agent_create", owner: { type: "near", account_id: "owner.near", public_key } });
  const prepare = (action: object = create()) => call(port, rpc("org_1", "owner/prepare"), "POST", staging, { json: { action, signer: "wallet" } });
  state.reply.body = preparedReply("nep413");
  assert.equal((await prepare()).status, 200, "the app prepares the creation the owner then signs");
  assert.equal((await prepare(create(`ed25519:${"1".repeat(44)}`))).status, 403, "with the key that signed the setup, not one the app picks");
  assert.equal((await call(port, rpc("org_1", "overview"), "POST", staging, {})).status, 403, "a setup consent reads nothing");
  assert.equal((await call(port, rpc("org_2", "owner/prepare"), "POST", staging, { json: { action: create(), signer: "wallet" } })).status, 403, "another Organization");
  assert.throws(() => consentMessage(fields({ agentId: "unborn" })), "a consent can't name the not-created stand-in");
  const forged = JSON.parse(consentMessage(fields({ scopes: ["read"] })));
  const unbornText = JSON.stringify({ ...forged, agentId: "unborn" });
  assert.equal((await call(port, "/apps/v1/consents", "POST", staging, await signed(unbornText))).status, 400, "nor can a hand-built text");
  assert.equal((await call(port, "/apps/v1/consents", "POST", staging, await signed(consentMessage(fields({ agentId: "some-id" }))))).status, 409,
    "an ordinary consent can't attach to an agent that isn't created");

  state.providerId = "provider-id";
  assert.equal((await prepare()).status, 403, "once created, the setup consent prepares nothing");
  for (const follow of ["owner/status", "owner/actions", "owner/pending"])
    assert.equal((await call(port, rpc("org_1", follow), "POST", staging, { json: { correlationId: "c" } })).status, 200, `${follow}: it can still follow the creation it relayed`);
  assert.equal((await call(port, rpc("org_1", "owner/submit"), "POST", staging, { json: { correlationId: "c", signedData: {} } })).status, 403, "but submits nothing");
  assert.equal((await call(port, "/apps/v1/consents", "POST", staging, await signed(consentMessage(fields({ scopes: ["owner", "read"] }))))).status, 201);
  assert.equal((await prepare({ type: "agent_freeze" })).status, 200, "the owner's consent for the created agent takes over");
  assert.equal((await call(port, rpc("org_1", "overview"), "POST", staging, {})).status, 200);

  assert.equal((await call(port, `/apps/v1/consents/${done.body.consent.id}`, "DELETE", staging)).status, 200);
  const before = reserved.length;
  assert.equal((await post(body)).status, 400, "a revoked setup can't be resubmitted");
  assert.equal(reserved.length, before, "and nothing is reserved for it");
  state.setup = async () => { throw new Error("Hosted agent capacity reached. Existing agents remain available."); };
  const full = await post(await signed(setupMessage(setupFields({ area: "treasury" }))));
  assert.deepEqual([full.status, full.body.error], [409, "Hosted agent capacity reached. Existing agents remain available."]);
});

for (const removed of ["absent", "FunctionCall"] as const)
  test(`a key the chain reports ${removed === "absent" ? "removed" : "no longer full-access"} revokes its consents for good: re-adding it revives nothing`, async t => {
    const { port, state, staging, rpc, consent } = await routeHarness(t);
    const body = await signed(consentMessage(fields()));
    const stored = await call(port, "/apps/v1/consents", "POST", staging, body);
    assert.equal(stored.status, 201);
    assert.equal((await call(port, rpc("org_1", "overview"), "POST", staging, {})).status, 200);
    state.keys = async () => removed;
    assert.equal((await call(port, rpc("org_1", "overview"), "POST", staging, {})).status, 403, removed);
    state.keys = async () => "FullAccess";
    assert.equal((await call(port, rpc("org_1", "overview"), "POST", staging, {})).status, 403, `${removed}: the same key re-added`);
    assert.equal((await call(port, "/apps/v1/consents", "POST", staging, body)).status, 400, "and the same signature can't be stored again");
    assert.equal((await consent()).status, 201, "the owner can sign a new consent");
    assert.match(readFileSync(join(".app-access", "revoked", stored.body.consent.id), "utf8"), removed === "absent" ? / key-removed$/m : / key-not-full-access$/m);
  });

test("the chain key check decides only on an answer: absent and function-call keys are definite, anything else throws", async t => {
  const block = { block_hash: "5f8R8jZuPxPXMKk7ghU8ZtMJdAfqgRqfxHP2Ke7F3rC7", block_height: 219835073 };
  let answer: () => Response = () => Response.json({});
  t.mock.method(globalThis, "fetch", async () => answer());
  const cases: [string, () => Response, KeyState | "throws"][] = [
    ["full access", () => Response.json({ jsonrpc: "2.0", id: 1, result: { ...block, nonce: 1, permission: "FullAccess" } }), "FullAccess"],
    ["function call", () => Response.json({ jsonrpc: "2.0", id: 1, result: { ...block, nonce: 1, permission: { FunctionCall: { allowance: null, receiver_id: "x.near", method_names: [] } } } }), "FunctionCall"],
    ["key missing (result.error)", () => Response.json({ jsonrpc: "2.0", id: 1, result: { ...block, logs: [], error: "access key ed25519:abc does not exist while viewing" } }), "absent"],
    ["key missing (error cause)", () => Response.json({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY", info: {} }, code: -32000, message: "Server error" } }), "absent"],
    ["account gone", () => Response.json({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: {} }, code: -32000, message: "Server error" } }), "absent"],
    ["rpc timeout", () => Response.json({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR", info: {} }, code: -32000, message: "Server error" } }), "throws"],
    ["http 503", () => new Response("busy", { status: 503 }), "throws"],
    ["other query error", () => Response.json({ jsonrpc: "2.0", id: 1, result: { ...block, logs: [], error: "something else" } }), "throws"],
    ["no permission", () => Response.json({ jsonrpc: "2.0", id: 1, result: { ...block } }), "throws"],
  ];
  for (const [name, response, expected] of cases) {
    answer = response;
    if (expected === "throws") await assert.rejects(chainKeyState("owner.near", "ed25519:abc"), name);
    else assert.equal(await chainKeyState("owner.near", "ed25519:abc"), expected, name);
  }
});

/** A stored-consent stand-in; storage doesn't re-verify signatures. */
const record = (i: number, over: Partial<VerifiedConsent> = {}): VerifiedConsent => ({ version: 1, id: i.toString(16).padStart(64, "0"), deployment: "staging",
  host: HOST, organization: `org_${i}`, owner: "owner.near", agent: "payout", agentId: "provider-id", scopes: ["read"], expiresAt: Date.now() + 86_400_000,
  message: "m", nonce: "n", publicKey: `ed25519:key${i}`, signature: "s", ...over });

test("the operator sweep revokes consents whose key is gone and leaves unanswered ones alone", async t => {
  const dir = mkdtempSync(join(tmpdir(), "app-sweep-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new AppConsents(dir);
  for (const i of [1, 2, 3]) store.store(record(i));
  store.store(record(4, { expiresAt: Date.now() - 1 }));
  const states: Record<string, () => Promise<KeyState>> = { "ed25519:key1": async () => "FullAccess", "ed25519:key2": async () => "absent",
    "ed25519:key3": async () => { throw new Error("rpc down"); } };
  const result = await sweepConsentKeys(store, (_owner, key) => states[key]!());
  assert.deepEqual(result, { checked: 3, revoked: [record(2).id], unanswered: [record(3).id] });
  assert.equal(store.isRevoked(record(2).id), true);
  assert.equal(store.isRevoked(record(3).id), false);
});

test("consents read from memory still see another process's store and revocation at once, and ended ones are archived, never lost", async t => {
  const dir = mkdtempSync(join(tmpdir(), "app-cache-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gateway = new AppConsents(dir), operator = new AppConsents(dir);
  const live = (store: AppConsents) => store.list({}).filter(r => !r.revoked).map(r => r.organization).sort();
  gateway.store(record(1));
  assert.deepEqual(live(gateway), ["org_1"]);
  operator.store(record(2));
  assert.deepEqual(live(gateway), ["org_1", "org_2"], "a record stored elsewhere is read");
  assert.ok(operator.revoke(record(1).id, null));
  assert.deepEqual(live(gateway), ["org_2"], "a revocation from another process applies at once");
  // Ended long ago: revoked, and expired. Ended recently, and live: kept.
  const DAY = 86_400_000, now = Date.now();
  gateway.store(record(3, { expiresAt: now + DAY }), now - 40 * DAY);
  operator.revoke(record(3).id, null, now - 31 * DAY);
  writeFileSync(join(dir, "consents", `${record(4).id}.json`), JSON.stringify({ ...record(4, { expiresAt: now - 31 * DAY }), createdAt: 0, revoked: false, revokedAt: null }));
  writeFileSync(join(dir, "consents", `${record(5).id}.json`), JSON.stringify({ ...record(5, { expiresAt: now - DAY }), createdAt: 0, revoked: false, revokedAt: null }));
  assert.deepEqual(gateway.archive(now).sort(), [record(3).id, record(4).id]);
  assert.deepEqual(readdirSync(join(dir, "consents-ended")).sort(), [`${record(3).id}.json`, `${record(4).id}.json`]);
  assert.deepEqual(gateway.list({}).map(r => r.organization).sort(), ["org_1", "org_2", "org_5"]);
  assert.throws(() => gateway.store(record(3)), /was revoked/, "an archived revocation still refuses its signature");
  assert.deepEqual(gateway.archive(now), [], "archiving again moves nothing");
  // An ended record is final: revoking an expired consent writes only its tombstone, so archiving races no writer.
  const expired = join(dir, "consents", `${record(5).id}.json`), text = readFileSync(expired, "utf8");
  assert.ok(operator.revoke(record(5).id, null, now));
  assert.equal(readFileSync(expired, "utf8"), text);
  assert.equal(gateway.list({}).find(r => r.id === record(5).id)?.revoked, true, "the tombstone still says it's revoked");
});

test("each deployment holds a bounded number of live consents; expired or revoked ones and other deployments' don't count", async t => {
  const dir = mkdtempSync(join(tmpdir(), "app-cap-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new AppConsents(dir);
  store.store(record(1));
  // The rest written as stored records directly; storing each through `store` re-reads them all every time.
  const file = (r: VerifiedConsent) => writeFileSync(join(dir, "consents", `${r.id}.json`), JSON.stringify({ ...r, createdAt: 0, revoked: false, revokedAt: null }));
  for (let i = 1; i <= 10; i++) file(record(10_000 + i, { expiresAt: Date.now() - 1 }));
  for (let i = 2; i <= MAX_CONSENTS_PER_DEPLOYMENT; i++) file(record(i));
  assert.throws(() => store.store(record(MAX_CONSENTS_PER_DEPLOYMENT + 1)), /too many live consents/);
  assert.equal(store.store(record(20_000, { deployment: "production" })).deployment, "production");
  // A revoked consent frees its place (#16); its tombstone still refuses its signature.
  assert.ok(store.revoke(record(2).id, null));
  assert.equal(store.store(record(MAX_CONSENTS_PER_DEPLOYMENT + 1)).revoked, false);
  assert.throws(() => store.store(record(2)), /was revoked/);
  assert.throws(() => store.store(record(MAX_CONSENTS_PER_DEPLOYMENT + 2)), /too many live consents/);
});

test("the operator lists and permanently revokes consents from the command line", t => {
  const dir = mkdtempSync(join(tmpdir(), "app-cli-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  new AppConsents(join(dir, ".app-access")).store(record(7));
  const cli = (...args: string[]) => spawnSync(join(import.meta.dirname, "../node_modules/.bin/tsx"), [join(import.meta.dirname, "../src/app-credential.ts"), ...args], { cwd: dir, encoding: "utf8" });
  assert.match(cli("consents", "staging").stdout, new RegExp(`${record(7).id}  staging  ${HOST}  org_7`));
  assert.equal(cli("revoke-consent", record(7).id).status, 0);
  assert.match(cli("consents").stdout, /revoked/);
  assert.equal(new AppConsents(join(dir, ".app-access")).isRevoked(record(7).id), true);
  assert.notEqual(cli("revoke-consent", "not-an-id").status, 0);
});

test("an agent not created yet is visible to its wallet owner's setup, never to machine access", async t => {
  let answer: unknown = { agentId: null, owner: null };
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname.startsWith("/rpc/")) return Response.json({ json: answer });
    return Response.json({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: {} }, code: -32000, message: "Server error" } });
  });
  const agent = { name: "payout", owner: "owner.near", port: 1 };
  assert.equal((await resolveWalletAuthority("owner.near", agent))?.agentId, null);
  assert.equal(await resolveMachineAccess("owner.near", agent), null);
  answer = { agentId: "provider-id", owner: { type: "near", account_id: "someone-else.near" } };
  assert.equal(await resolveWalletAuthority("owner.near", agent), null, "an agent reporting another owner is closed");
  answer = { agentId: "provider-id", owner: null };
  await assert.rejects(resolveWalletAuthority("owner.near", agent), AuthorityUnanswered, "half an identity is not evidence: nothing is decided");
  assert.equal(await resolveMachineAccess("owner.near", agent), null, "and machine access stays refused");
  answer = { agentId: "provider-id", owner: { type: "near", account_id: "owner.near" } };
  assert.equal((await resolveMachineAccess("owner.near", agent))?.agentId, "provider-id");
  assert.equal(await resolveWalletAuthority("intruder.near", agent), null);
});

test("while the gateway stops, setup, consents and confirm submissions are refused and nothing is stored, reserved or used", async t => {
  const { port, state, staging, rpc, consent } = await routeHarness(t);
  assert.equal((await consent({ scopes: ["owner"] })).status, 201);
  state.reply.body = preparedReply("nep366", "c-stop");
  const held = await call(port, rpc("org_1", "owner/prepare"), "POST", staging, { json: { action: { type: "agent_freeze" }, signer: "wallet" } });
  const api = new URL(held.body.json.confirm.url).pathname.replace("/confirm/", "/confirm/v1/");
  const reserved: unknown[] = [];
  state.setup = async input => { reserved.push(input); return { name: "own-x", owner: input.owner, area: input.area, port: 1, executor: true } as never; };
  state.stopping = true;
  assert.equal((await call(port, "/apps/v1/setup", "POST", staging, await signed(setupMessage(setupFields())))).status, 503);
  assert.deepEqual(reserved, [], "nothing reserved");
  assert.equal((await consent({ organization: "org_9" })).status, 503);
  assert.equal((await call(port, api, "POST", undefined, { signedData: signDelegate() })).status, 503);
  state.stopping = false;
  assert.equal((await call(port, "/apps/v1/consents?organization=org_9", "GET", staging)).body.consents.length, 0, "nothing stored");
  assert.equal((await call(port, api)).body.state, "open", "the link stays usable");
});

test("a confirm link whose agent this gateway no longer serves answers 503 and keeps the owner's signature unspent", async t => {
  const { port, state, staging, rpc, consent, forwarded } = await routeHarness(t);
  assert.equal((await consent({ scopes: ["owner"] })).status, 201);
  state.reply.body = preparedReply("nep366", "c-gone");
  const held = await call(port, rpc("org_1", "owner/prepare"), "POST", staging, { json: { action: { type: "agent_freeze" }, signer: "wallet" } });
  const api = new URL(held.body.json.confirm.url).pathname.replace("/confirm/", "/confirm/v1/");
  const dir = join(".app-access", "confirm");
  for (const file of readdirSync(dir).filter(f => f.endsWith(".json"))) {
    const record = JSON.parse(readFileSync(join(dir, file), "utf8"));
    if (record.correlationId === "c-gone") writeFileSync(join(dir, file), JSON.stringify({ ...record, agent: "gone" }));
  }
  const before = forwarded.length;
  assert.equal((await call(port, api, "POST", undefined, { signedData: signDelegate() })).status, 503);
  assert.equal(forwarded.length, before);
  assert.equal((await call(port, api)).body.state, "open", "the link isn't used");
});

test("the call that observes a removed key is refused by the key check itself; access ending during that check refuses before forwarding", async t => {
  const { port, state, staging, rpc, forwarded } = await routeHarness(t);
  const stored = await call(port, "/apps/v1/consents", "POST", staging, await signed(consentMessage(fields())));
  assert.equal(stored.status, 201);
  state.keys = async () => "absent";
  const removed = await call(port, rpc("org_1", "overview"), "POST", staging, {});
  assert.deepEqual([removed.status, removed.body.error], [403, "The key that signed this consent was removed from its owner's account, so the consent was revoked"]);
  state.keys = async () => "FullAccess";
  const second = await call(port, "/apps/v1/consents", "POST", staging, await signed(consentMessage(fields({ organization: "org_2" }))));
  assert.equal(second.status, 201);
  // The credential is revoked while the key check waits on the chain.
  state.keys = async () => { new AppCredentials(".app-access").revoke(new AppCredentials(".app-access").list().find(c => c.deployment === "staging")!.id); return "FullAccess"; };
  const before = forwarded.length;
  const ended = await call(port, rpc("org_2", "overview"), "POST", staging, {});
  assert.deepEqual([ended.status, ended.body.error], [403, "Access ended before forwarding"]);
  assert.equal(forwarded.length, before, "nothing forwarded");
});

test("a stop that begins while an agent call is checked answers 503, an outage, not the end of access", async t => {
  const { port, state, staging, rpc, forwarded } = await routeHarness(t);
  assert.equal((await call(port, "/apps/v1/consents", "POST", staging, await signed(consentMessage(fields())))).status, 201);
  state.keys = async () => { state.stopping = true; return "FullAccess"; };
  const before = forwarded.length;
  const stopped = await call(port, rpc("org_1", "overview"), "POST", staging, {});
  assert.deepEqual([stopped.status, stopped.body.error], [503, "Gateway is stopping. Nothing was forwarded."]);
  assert.equal(forwarded.length, before);
});

test("a consent isn't stored when its deployment's credential is revoked while the signer's key is checked", async t => {
  const { port, state, staging } = await routeHarness(t);
  state.keys = async () => { const credentials = new AppCredentials(".app-access"); credentials.revoke(credentials.list().find(c => c.deployment === "staging")!.id); return "FullAccess"; };
  const ended = await call(port, "/apps/v1/consents", "POST", staging, await signed(consentMessage(fields())));
  assert.deepEqual([ended.status, ended.body.error], [403, "Access ended before storing. Nothing was stored."]);
  assert.deepEqual(new AppConsents(".app-access").list({}), [], "a later credential for this deployment inherits nothing");
});

test("each credential has an hourly request limit, and its 429 says when to try again (#15)", async t => {
  const { port, staging } = await routeHarness(t);
  let last: Awaited<ReturnType<typeof call>> | undefined;
  for (let i = 0; i < 1_201; i++) last = await call(port, "/apps/v1/agents/payout", "GET", staging);
  assert.equal(last!.status, 429);
  const after = Number(last!.headers["retry-after"]);
  assert.ok(Number.isInteger(after) && after >= 1 && after <= 3_600, `Retry-After ${last!.headers["retry-after"]}`);
  assert.deepEqual(last!.body, { error: "Request limit reached", retryAfterSeconds: after });
  // The SDK reports it as its own kind, never as a refusal of the request or an unknown outcome.
  const httpFetch: typeof fetch = async (input, init) => {
    const answered = await call(port, new URL(String(input)).pathname, init?.method ?? "GET", staging, init?.body ? JSON.parse(String(init.body)) : undefined);
    return Response.json(answered.body, { status: answered.status, headers: answered.headers["retry-after"] ? { "retry-after": String(answered.headers["retry-after"]) } : {} });
  };
  const app = appClient({ base: `http://127.0.0.1:${port}`, credential: staging, fetch: httpFetch });
  // The wait counts down while the calls run: each answer names the same window, a few seconds later at most.
  const limited = (result: unknown) => {
    const { retryAfterSeconds, ...rest } = result as { retryAfterSeconds?: number };
    assert.deepEqual(rest, { ok: false, kind: "rate_limited", status: 429, error: "Request limit reached" });
    assert.ok(retryAfterSeconds !== undefined && retryAfterSeconds <= after && retryAfterSeconds >= after - 5, `retryAfterSeconds ${retryAfterSeconds}, first ${after}`);
  };
  limited(await app.identity("payout"));
  limited(await app.agent("org_1", "payout").call("proposals/create", { requestId: "r", legs: "strategy", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
  limited(await app.agent("org_1", "payout").call("overview"));
  // A proxy's 429 page isn't the gateway's answer: the routes keep their old kind for it.
  const proxied = appClient({ base: `http://127.0.0.1:${port}`, credential: staging, fetch: async () => new Response("<html>slow down</html>", { status: 429 }) });
  assert.deepEqual(await proxied.identity("payout"), { ok: false, kind: "refused", status: 429, error: "HTTP 429" });
});

test("the gateway holds each credential to the limit the operator set, read on every call (#15)", async t => {
  const { port, production } = await routeHarness(t);
  const credentials = new AppCredentials(".app-access");
  const { credential, token } = credentials.issue({ deployment: "small", host: HOST, label: "small", days: 30, perHour: 2 });
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) statuses.push((await call(port, "/apps/v1/agents/payout", "GET", token)).status);
  assert.deepEqual(statuses.map(s => s === 429), [false, false, true], `statuses ${statuses}`);
  assert.notEqual((await call(port, "/apps/v1/agents/payout", "GET", production)).status, 429, "another deployment keeps its own budget");
  // Raised in place: the same token passes at once, with no restart.
  assert.equal(credentials.limit(credential.id, 10), true);
  assert.notEqual((await call(port, "/apps/v1/agents/payout", "GET", token)).status, 429);
});

test("calls carrying an owner's or DAO's signature draw on their own budget, and each 429 is logged with its Organization (#59)", async t => {
  const { port } = await routeHarness(t);
  const { token } = new AppCredentials(".app-access").issue({ deployment: "busy", host: HOST, label: "busy", days: 30, perHour: 2 });
  const ordinary = () => call(port, "/apps/v1/o/org_1/a/payout/rpc/overview", "POST", token, { json: {} });
  const submit = () => call(port, "/apps/v1/o/org_1/a/payout/rpc/owner/submit", "POST", token, { json: { correlationId: "c", signedData: {} } });
  const daoVote = () => call(port, `/apps/v1/dao-votes/${"a".repeat(64)}`, "GET", token);
  const statuses = async (calls: (() => ReturnType<typeof call>)[]) => { const out: number[] = []; for (const c of calls) out.push((await c()).status); return out; };
  // Ordinary traffic uses up its hour...
  assert.deepEqual((await statuses([ordinary, ordinary, ordinary])).map(s => s === 429), [false, false, true]);
  // ...and an owner's submission or a DAO vote's relay still gets through: a 429 there would waste a signature.
  assert.deepEqual((await statuses([submit, daoVote])).map(s => s === 429), [false, false]);
  // They have a budget of their own, so they can't be used to get around the limit.
  assert.equal((await submit()).status, 429);
  const limited = accessLogText().trim().split("\n").map(line => JSON.parse(line)).filter(line => line.event === "rate_limited");
  assert.deepEqual(limited.map(({ deployment, budget, organization }) => ({ deployment, budget, organization })),
    [{ deployment: "busy", budget: "shared", organization: "org_1" }, { deployment: "busy", budget: "signed", organization: "org_1" }],
    "one line per budget and minute, naming the Organization in the path");
  await ordinary();
  assert.equal(accessLogText().trim().split("\n").filter(line => line.includes('"rate_limited"')).length, 2, "a repeated 429 within the minute adds no line");
});

test("one Organization can't use up the hour of an app's other Organizations: each seen keeps a slice (#59)", async t => {
  const { port } = await routeHarness(t);
  const { token } = new AppCredentials(".app-access").issue({ deployment: "tenants", host: HOST, label: "tenants", days: 30, perHour: 40 });
  const overview = (org: string) => call(port, `/apps/v1/o/${org}/a/payout/rpc/overview`, "POST", token, { json: {} });
  const allowed = async (org: string, n: number) => { let ok = 0; for (let i = 0; i < n; i++) if ((await overview(org)).status !== 429) ok++; return ok; };
  assert.equal(await allowed("org_2", 1), 1, "org_2 is seen, with 1 of its slice of 2 used");
  // org_1 gets everything but what org_2 is still owed: 40 - 1 used - 1 owed.
  assert.equal(await allowed("org_1", 40), 38);
  assert.equal(await allowed("org_2", 1), 1, "org_2 still gets its slice");
  const limited = accessLogText().trim().split("\n").map(line => JSON.parse(line)).filter(line => line.event === "rate_limited" && line.deployment === "tenants");
  assert.deepEqual(limited.map(({ budget, reason, organization }) => ({ budget, reason, organization })), [{ budget: "shared", reason: "fair_share", organization: "org_1" }]);
});

test("app access state is written only into a directory no one else can read", t => {
  const dir = mkdtempSync(join(tmpdir(), "app-private-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "confirm"), { mode: 0o755 }); chmodSync(join(dir, "confirm"), 0o755);
  assert.throws(() => new AppConfirms(dir).hold({ deployment: "d", host: HOST, organization: "o", owner: "owner.near", agent: "payout", agentId: null,
    consent: "c", correlationId: "c-private", type: "agent_freeze", action: {}, policy: null, summary: null, expiresAt: later(1),
    intent: { standard: "nep366", payload: {} }, signer: { type: "near", account_id: "owner.near", public_key: "ed25519:k" } }), /must be private/);
  assert.equal(readdirSync(join(dir, "confirm")).length, 0, "nothing written");
});

test("a setup stores no consent when access ends or a stop begins while its agent is being reserved", async t => {
  const { port, state, staging } = await routeHarness(t);
  const body = await signed(setupMessage(setupFields()));
  state.providerId = null;
  const reserve = (during: () => void): HostedSetup => async input => { during(); return { name: "payout", owner: input.owner, port: 0, area: input.area, executor: true }; };
  state.setup = reserve(() => { state.stopping = true; });
  assert.equal((await call(port, "/apps/v1/setup", "POST", staging, body)).status, 503, "a stop begun meanwhile");
  state.stopping = false;
  const credentials = new AppCredentials(".app-access");
  state.setup = reserve(() => { for (const c of credentials.list()) if (c.deployment === "staging") credentials.revoke(c.id); });
  assert.equal((await call(port, "/apps/v1/setup", "POST", staging, body)).status, 403, "a credential revoked meanwhile");
  assert.equal(new AppConsents(".app-access").list({}).length, 0, "nothing stored");
});

test("a setup whose reply was lost: the same signed setup answers the same agent until it expires; afterwards the deployment finds the agent it reserved by Organization, owner and area", async t => {
  const { port, agent, state, staging, production } = await routeHarness(t);
  Object.assign(agent, { deployment: "staging", organization: "org_1" });
  state.providerId = null;
  const reserved: string[] = [];
  let stopDuring = true;
  // A gateway that dies between reserving and storing leaves the reservation and no consent, like a stop begun meanwhile.
  state.setup = async input => { reserved.push(input.owner); if (stopDuring) state.stopping = true; return agent; };
  const body = await signed(setupMessage(setupFields()));
  assert.equal((await call(port, "/apps/v1/setup", "POST", staging, body)).status, 503, "reserved, then the reply was lost");
  assert.equal(new AppConsents(".app-access").list({}).length, 0, "and no setup consent names the agent");
  state.stopping = false; stopDuring = false;
  const again = await call(port, "/apps/v1/setup", "POST", staging, body);
  assert.deepEqual([again.status, again.body.agent], [201, "payout"], "the same signed setup answers the same reservation");
  const once = await call(port, "/apps/v1/setup", "POST", staging, body);
  assert.deepEqual([once.body.agent, once.body.consent.id], ["payout", again.body.consent.id], "and the same setup consent");
  assert.deepEqual(reserved, ["owner.near", "owner.near", "owner.near"], "each found the one reservation (the registry returns it again)");

  const expired = Date.parse(JSON.parse(body.message).expiresAt) + 60_000;
  t.mock.method(Date, "now", () => expired);
  const late = await call(port, "/apps/v1/setup", "POST", staging, body);
  assert.deepEqual([late.status, late.body.code], [400, "invalid_request"], "an expired setup reserves and answers nothing");
  assert.equal(reserved.length, 3, "nothing reserved for it");
  new AppConsents(".app-access").archive(expired + 31 * 86_400_000);
  assert.deepEqual((await call(port, "/apps/v1/consents?organization=org_1", "GET", staging)).body.consents, [], "its setup consent archived, no consent names the agent");

  const find = (query: string, token = staging) => call(port, `/apps/v1/agents?${query}`, "GET", token);
  const found = await find("organization=org_1&owner=owner.near&area=payables");
  assert.equal(found.status, 200, JSON.stringify(found.body));
  assert.deepEqual(found.body, { agents: [{ agent: "payout", organization: "org_1", owner: "owner.near", area: "payables" }] });
  assert.deepEqual((await find("organization=org_1")).body.agents.map((a: { agent: string }) => a.agent), ["payout"], "owner and area narrow it");
  for (const query of ["organization=org_1&owner=other.near", "organization=org_1&area=treasury", "organization=org_2"])
    assert.deepEqual((await find(query)).body, { agents: [] }, query);
  assert.deepEqual((await find("organization=org_1", production)).body, { agents: [] }, "another deployment's reservations are never listed");
  Object.assign(agent, { deployment: undefined, organization: undefined });
  assert.deepEqual((await find("organization=org_1")).body, { agents: [] }, "nor an agent no app set up");
  for (const query of ["", "organization=", "organization=org_1&area=invoices", "organization=org_1&owner=Bad%20Owner"])
    assert.deepEqual([(await find(query)).status, (await find(query)).body.code], [400, "invalid_request"], query);
  assert.equal((await call(port, "/apps/v1/agents?organization=org_1", "POST", staging, {})).status, 405);
  assert.equal((await call(port, "/apps/v1/agents?organization=org_1", "GET")).status, 401);

  Object.assign(agent, { deployment: "staging", organization: "org_1" });
  const client = appClient({ base: `http://127.0.0.1:${port}`, credential: staging, fetch: httpFetch });
  const typed = await client.reservations({ organization: "org_1", owner: "owner.near", area: "payables" });
  assert.deepEqual(typed.ok && typed.value.agents.map(a => [a.agent, a.area]), [["payout", "payables"]], "the SDK reads the same, typed");
  const bad = await client.reservations({ organization: "org 1" });
  assert.deepEqual(bad.ok === false && [bad.kind, "code" in bad && bad.code], ["refused", "invalid_request"]);
});

test("under a wallet's consent, read reaches account and reconcileBooks, treasury reaches the link and a tick, and no scope reaches setup, recover or fund", async t => {
  const { port, forwarded, staging, rpc, consent } = await routeHarness(t);
  assert.equal((await consent({ scopes: ["owner"] })).status, 201);
  const before = forwarded.length;
  for (const procedure of ["account", "reconcileBooks"])
    assert.equal((await call(port, rpc("org_1", procedure), "POST", staging, {})).status, 403, `${procedure}: needs read`);
  assert.equal(forwarded.length, before);
  assert.equal((await consent({ organization: "org_2", scopes: ["read", "owner", "payout", "treasury", "treasury-execute"] })).status, 201);
  for (const procedure of ["account", "reconcileBooks"])
    assert.equal((await call(port, rpc("org_2", procedure), "POST", staging, {})).status, 200, procedure);
  for (const procedure of ["setup", "recover", "treasury/fund"])
    assert.equal((await call(port, rpc("org_2", procedure), "POST", staging, {})).status, 403, `${procedure}: owner-session only, whatever the scopes`);
  for (const procedure of ["treasury/link", "treasury/unlink", "autopilot/tick"])
    assert.equal((await call(port, rpc("org_2", procedure), "POST", staging, { json: { accountId: "treasury.near" } })).status, 200,
      `${procedure}: a wallet owner's treasury consent reaches it`);
  assert.equal((await consent({ organization: "org_3", scopes: ["read"] })).status, 201);
  for (const procedure of ["treasury/link", "autopilot/tick"])
    assert.equal((await call(port, rpc("org_3", procedure), "POST", staging, { json: { accountId: "treasury.near" } })).status, 403, `${procedure}: needs treasury`);
});

test("every refusal code the app routes send is one the package lists, and each listed code is sent", () => {
  const source = (file: string) => readFileSync(new URL(`../src/gateway/${file}`, import.meta.url), "utf8");
  const sent = new Set(["invalid_request", ...[...source("app-routes.ts").matchAll(/code: "([a-z_]+)"/g)].map(m => m[1]),
    ...["app-access.ts", "app-dao.ts"].flatMap(file => [...source(file).matchAll(/new BadRequest\([^;]*, "([a-z_]+)"\);/g)].map(m => m[1]))]);
  assert.deepEqual([...sent].sort(), [...APP_GATEWAY_CODES].sort());
});

test("owner/prepare's answer narrows to the DAO's or the wallet's by what it carries", () => {
  const base = { correlationId: "c", preview: { summary: "Freeze" }, expiresAt: later(0.005), digest: null };
  const dao = { ...base, dao: { owner: "x", transaction: { receiverId: "v1.signer", actions: [] }, proposal: null, proposalAndVote: null } } as unknown as AppPrepared;
  const linked = { ...base, confirm: { url: "https://h/confirm/x", expiresAt: later(0.005) } } as unknown as AppPrepared;
  assert.deepEqual([isDaoPrepared(dao), isWalletPrepared(dao)], [true, false]);
  assert.deepEqual([isDaoPrepared(linked), isWalletPrepared(linked)], [false, true]);
  if (isDaoPrepared(dao)) assert.equal(dao.dao.transaction.receiverId, "v1.signer", "typed without probing");
});

test("the gateway's coded refusal before forwarding an agent call is refused with its code; a plain 400 stays unknown", async () => {
  const answering = (status: number, body: string) => appClient({ base: "https://platform.test", credential: "tap_x",
    fetch: async () => new Response(body, { status, headers: { "content-type": "application/json" } }) }).agent("org_1", "treasury");
  const signed = { id: "p-1", signed: { message: "m", nonce: "n", publicKey: "k", signature: "s" } };
  assert.deepEqual(await answering(400, JSON.stringify({ code: "signature_invalid", error: "Not the owner's key. Nothing was recorded." })).call("proposals/approve", signed),
    { ok: false, kind: "refused", status: 400, code: "signature_invalid", error: "Not the owner's key. Nothing was recorded." });
  const proxy = await answering(400, "<html>bad request</html>").call("proposals/approve", signed);
  assert.deepEqual(proxy.ok === false && [proxy.kind, "httpStatus" in proxy && proxy.httpStatus], ["unknown", 400], "a page with no code proves nothing");
  const older = await answering(400, JSON.stringify({ error: "An older gateway's refusal" })).call("proposals/approve", signed);
  assert.equal(older.ok === false && older.kind, "unknown", "an older gateway names no code, so nothing changes for it");
});

/** The owner's wallet stop as `wallet-stop.ts` records it once applied: its cutoff `at`, and the agents it named. */
function recordWalletStop(at: number, targets: string[], agent = "*") {
  const id = randomBytes(32).toString("hex");
  mkdirSync(join(APP_ROOT, "wallet-stops"), { recursive: true });
  writeFileSync(join(APP_ROOT, "wallet-stops", `${id}.json`), JSON.stringify({ version: 1, id, host: HOST, owner: "owner.near", agent,
    message: "m", nonce: "n", publicKey: "k", signature: "s", expiresAt: at + 600_000, at,
    targets: targets.map(name => ({ agent: name, agentId: "provider-id" })), ended: [], settled: {} }));
}
const pause = () => new Promise(resolve => setTimeout(resolve, 5));

test("after the owner's wallet stop, a consent is stored only if the platform issued its nonce after the stop", async t => {
  const { port, staging, production } = await routeHarness(t);
  const issue = async (token = staging) => {
    const answer = await call(port, "/apps/v1/consent-nonces", "POST", token, {});
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.ok(Math.abs(answer.body.issuedAt - Date.now()) < 5_000);
    assert.equal(Buffer.from(answer.body.nonce, "base64").length, 32);
    return Buffer.from(answer.body.nonce, "base64");
  };
  const submit = async (nonce?: Buffer, scopes: ("read" | "treasury")[] = ["read", "treasury"]) =>
    call(port, "/apps/v1/consents", "POST", staging, await signed(consentMessage(fields({ scopes })), "owner.near", HOST, nonce));
  assert.equal((await call(port, "/apps/v1/consent-nonces", "POST", undefined, {})).status, 401);
  assert.equal((await submit(undefined, ["read"])).status, 201, "with no stop, an app's own nonce is accepted as before");
  const early = await issue(), elsewhere = await issue(production);
  await pause(); recordWalletStop(Date.now(), ["payout"]); await pause();
  assert.deepEqual(denial(await submit()), [409, "owner_stopped", undefined], "its own nonce: it may have been signed before the stop");
  assert.deepEqual(denial(await submit(early)), [409, "owner_stopped", undefined], "issued before the stop");
  assert.deepEqual(denial(await submit(elsewhere)), [409, "owner_stopped", undefined], "issued to another deployment");
  const forged = Buffer.from(early); forged.writeBigUInt64BE(BigInt(Date.now() + 60_000), 0);
  assert.deepEqual(denial(await submit(forged)), [409, "owner_stopped", undefined], "a changed issue time doesn't verify");
  const fresh = await submit(await issue());
  assert.equal(fresh.status, 201, JSON.stringify(fresh.body));

  // Another owner's unreadable stop record is never this owner's concern.
  writeFileSync(join(APP_ROOT, "wallet-stops", `${"f".repeat(64)}.json`), JSON.stringify({ version: 2, host: HOST, owner: "someone-else.near" }));
  assert.equal((await submit(await issue())).status, 201);
});

test("after the owner's wallet stop for every agent, a setup is stored only with a nonce the platform issued after it", async t => {
  const { port, state, staging } = await routeHarness(t);
  state.providerId = null;
  let reserved = 0;
  state.setup = async input => { reserved++; return { name: "own-new", owner: input.owner, port: 0, area: input.area, executor: true }; };
  const issue = async () => Buffer.from((await call(port, "/apps/v1/consent-nonces", "POST", staging, {})).body.nonce, "base64");
  const setup = async (nonce?: Buffer) => call(port, "/apps/v1/setup", "POST", staging, await signed(setupMessage(setupFields()), "owner.near", HOST, nonce));
  const early = await issue();
  await pause(); recordWalletStop(Date.now(), ["payout"]); await pause();
  assert.deepEqual(denial(await setup(early)), [409, "owner_stopped", undefined]);
  assert.deepEqual(denial(await setup()), [409, "owner_stopped", undefined]);
  assert.equal(reserved, 0, "a stop for every agent refuses before anything is reserved");
  const fresh = await setup(await issue());
  assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
});
