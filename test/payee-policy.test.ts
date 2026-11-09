import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRouterClient } from "@orpc/server";
import { generateKey, Near, type KeyPair, type PrivateKey } from "near-kit";
import type { Policy } from "@near-intents-agent-api/sdk";
import { api } from "../src/api.js";
import { mayCall } from "../src/contract/permissions.js";
import { appScopesCover } from "../src/contract/app-access.js";
import { AppScope } from "../src/contract/app-consent.js";
import { parsePayeeDisclosureMessage, parsePayeePolicyReadMessage, payeeDisclosureMessage, payeePolicyProof, payeePolicyReadMessage,
  PAYEE_POLICY_PATH } from "../src/contract/payee-policy.js";
import { payeeClient } from "../src/contract/payee-entry.js";
import type { AgentEntry } from "../src/gateway/config.js";
import { payeePolicyRoutes } from "../src/gateway/payee-policy.js";
import { sendFailure } from "../src/http.js";
import { mandateDigest } from "../src/mandate.js";
import { ASSETS, payoutPolicy } from "../src/policy.js";
import { payeeTerms } from "../src/payee-terms.js";
import type { KeyState } from "../src/signin.js";
import { policyView } from "./fixtures/authority.js";

const HOST = "platform.test", OWNER = "owner.near", PAYEE = "alice.near", AGENT = "own-000000000000000000000001", AGENT_ID = "id-payout";
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
const close = (server: Server) => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
function call(port: number, path: string, method = "POST", body?: object) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { "content-type": "application/json" } }, res => {
      let text = ""; res.on("data", chunk => text += chunk);
      res.on("end", () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : null }));
    }); req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}

const ownerKey = generateKey(), payeeKey = generateKey();
async function signed(message: string, key: KeyPair, signer: string, recipient = HOST) {
  const nonce = randomBytes(32);
  const near = new Near({ network: "mainnet", privateKey: key.secretKey as PrivateKey, defaultSignerId: signer });
  const signature = await near.signMessage({ message, recipient, nonce });
  return { message, nonce: nonce.toString("base64"), publicKey: signature.publicKey, signature: signature.signature };
}
type Disclosure = { host?: string; owner?: string; agent?: string; agentId?: string; payee?: string; expiresAt?: string; discloseDigest?: true };
const disclosure = (over: Disclosure = {}, key = ownerKey) => signed(payeeDisclosureMessage({ host: over.host ?? HOST, owner: over.owner ?? OWNER,
  agent: over.agent ?? AGENT, agentId: over.agentId ?? AGENT_ID, payee: over.payee ?? PAYEE, expiresAt: over.expiresAt ?? inMinutes(60 * 24 * 30),
  ...(over.discloseDigest ? { discloseDigest: true as const } : {}) }), key, over.owner ?? OWNER);
type Read = { host?: string; payee?: string; agent?: string; expiresAt?: string };
const read = (over: Read = {}, key = payeeKey) => signed(payeePolicyReadMessage({ host: over.host ?? HOST, payee: over.payee ?? PAYEE,
  agent: over.agent ?? AGENT, expiresAt: over.expiresAt ?? inMinutes(10) }), key, over.payee ?? PAYEE);

/** Two payees, a withdrawal destination of Alice's and one on another chain, swap assets and every budget window: the full policy the payee must not see. */
const policy: Policy = (() => {
  const base = payoutPolicy([PAYEE, "bob.near"]);
  return { ...base, actions: ["transfer", "withdraw"], assets: [ASSETS.USDC, ASSETS.wNEAR],
    limits: { ...base.limits, per_transaction: { [ASSETS.USDC]: "25000000", [ASSETS.wNEAR]: "1000000000000000000000000", [ASSETS.ETH]: "1000" } },
    destinations: { mode: "only", list: [...base.destinations.list,
      { action: "withdraw", chain: "near", address: PAYEE, memo: null },
      { action: "withdraw", chain: "eth", address: PAYEE, memo: null },
      { action: "withdraw", chain: "near", address: "carol.near", memo: null }] } };
})();

test("the disclosure and read texts are canonical JSON, and only their canonical form parses", () => {
  const fields = { host: HOST, owner: OWNER, agent: AGENT, agentId: AGENT_ID, payee: PAYEE, expiresAt: "2026-12-01T00:00:00.000Z" };
  const text = payeeDisclosureMessage(fields);
  assert.equal(text, `{"type":"multiagency.payee-disclosure","version":1,"host":"platform.test","owner":"owner.near","agent":"${AGENT}","agentId":"id-payout","payee":"alice.near","expiresAt":"2026-12-01T00:00:00.000Z"}`);
  assert.deepEqual(parsePayeeDisclosureMessage(text), { type: "multiagency.payee-disclosure", version: 1, ...fields });
  assert.equal(parsePayeeDisclosureMessage(text.replace(',"payee"', ', "payee"')), null, "whitespace");
  assert.equal(parsePayeeDisclosureMessage(JSON.stringify({ ...JSON.parse(text), extra: 1 })), null, "an extra field");
  const readText = payeePolicyReadMessage({ host: HOST, payee: PAYEE, agent: AGENT, expiresAt: fields.expiresAt });
  assert.equal(readText, `{"type":"multiagency.payee-policy-read","version":1,"host":"platform.test","payee":"alice.near","agent":"${AGENT}","expiresAt":"2026-12-01T00:00:00.000Z"}`);
  assert.equal(parsePayeePolicyReadMessage(readText)?.payee, PAYEE);
  assert.equal(parsePayeePolicyReadMessage(text), null, "a disclosure is not a read");
  assert.equal(parsePayeeDisclosureMessage(readText), null, "a read is not a disclosure");
});

test("the owner opts in to the mandate digest in the signed text; without it the disclosure text is exactly as before", () => {
  const fields = { host: HOST, owner: OWNER, agent: AGENT, agentId: AGENT_ID, payee: PAYEE, expiresAt: "2026-12-01T00:00:00.000Z" };
  const before = payeeDisclosureMessage(fields);
  assert.equal(payeeDisclosureMessage({ ...fields, discloseDigest: undefined }), before, "absent is the default");
  const opted = payeeDisclosureMessage({ ...fields, discloseDigest: true });
  assert.equal(opted, `${before.slice(0, -1)},"discloseDigest":true}`);
  assert.deepEqual(parsePayeeDisclosureMessage(opted), { type: "multiagency.payee-disclosure", version: 1, ...fields, discloseDigest: true });
  assert.equal(parsePayeeDisclosureMessage(before)?.discloseDigest, undefined, "an old disclosure parses with no opt-in");
  assert.equal(parsePayeeDisclosureMessage(`${before.slice(0, -1)},"discloseDigest":false}`), null, "false is not a canonical form: absent is");
  assert.equal(parsePayeeDisclosureMessage(before.replace('"payee"', '"discloseDigest":true,"payee"')), null, "only at the end");
  assert.throws(() => payeeDisclosureMessage({ ...fields, discloseDigest: false as never }));
});

test("the payee's terms are only their own entries, the per-payment caps of assets the agent spends, approval, frozen and the revision", () => {
  const view = { ...policyView(policy, 7), applied_at: "2026-11-01T00:00:00.000Z", policy_hash: "provider-hash" };
  const terms = payeeTerms(view as never, PAYEE, AGENT_ID, new Date("2026-11-09T00:00:00.000Z"));
  assert.deepEqual(terms, {
    agentId: AGENT_ID, payee: PAYEE, observedAt: "2026-11-09T00:00:00.000Z", revision: 7, status: "APPLIED", appliedAt: "2026-11-01T00:00:00.000Z",
    synced: true, notInForce: null,
    terms: { frozen: false, ownerApproval: true, mode: "only", agreed: true,
      destinations: [{ action: "transfer", address: PAYEE, confidential: true, enabled: true }, { action: "withdraw", chain: "near", address: PAYEE, memo: null, enabled: true }],
      perTransaction: { [ASSETS.USDC]: "25000000", [ASSETS.wNEAR]: "1000000000000000000000000" } },
  });
  const shown = JSON.stringify(terms);
  assert.ok(!shown.includes(mandateDigest(policy).replace(/^sha256:/, "")), "never the mandate digest");
  for (const hidden of ["bob.near", "carol.near", '"eth"', "50000000", "200000000", "budget", "daily", "monthly", "provider-hash", ASSETS.ETH])
    assert.ok(!shown.includes(hidden), `discloses ${hidden}`);
  assert.deepEqual(payeeTermsOf({ ...policy, frozen: true, owner_approval: false, actions: ["withdraw"] }, PAYEE), { notInForce: "the agent is frozen",
    frozen: true, ownerApproval: false, agreed: true, enabled: [false, true] }, "a disabled action and a frozen agent are shown as such");
  assert.deepEqual(payeeTermsOf(policy, "dave.near"), { notInForce: null, frozen: false, ownerApproval: true, agreed: false, enabled: [] },
    "a payee the policy doesn't list sees no entry");
  assert.deepEqual(payeeTermsOf({ ...policy, destinations: { mode: "except", list: policy.destinations.list } }, PAYEE).agreed, false,
    "an except-mode listing is an exclusion, never an agreed payee");
  const none = payeeTerms({ ...policyView(policy), policy: null, revision: null, status: "NONE" } as never, PAYEE, AGENT_ID);
  assert.deepEqual([none.terms, none.notInForce], [null, "no policy is applied"]);
  assert.equal("digest" in terms, false, "no digest unless asked");
  const withDigest = payeeTerms(view as never, PAYEE, AGENT_ID, new Date("2026-11-09T00:00:00.000Z"), { digest: true });
  assert.deepEqual(withDigest, { ...terms, digest: mandateDigest(policy) }, "asked: the mandate digest of the provider's current policy, and nothing else more");
  assert.equal("digest" in payeeTerms({ ...policyView(policy), policy: null, revision: null, status: "NONE" } as never, PAYEE, AGENT_ID, new Date(), { digest: true }),
    false, "no policy, no digest");
});
function payeeTermsOf(p: Policy, payee: string) {
  const { notInForce, terms } = payeeTerms(policyView(p) as never, payee, AGENT_ID);
  return { notInForce, frozen: terms!.frozen, ownerApproval: terms!.ownerApproval, agreed: terms!.agreed, enabled: terms!.destinations.map(d => d.enabled) };
}

test("the agent's payeeTerms reads the provider's current policy, and no owner, app or machine permission reaches it", async t => {
  const reads: string[] = [];
  t.mock.method(api, "getPolicy", async (id: string) => { reads.push(id); return policyView(policy, 3); });
  const { router } = await import("../src/router.js");
  const answer = await createRouterClient(router).payeeTerms({ payee: PAYEE });
  assert.deepEqual(reads, [process.env.AGENT_ID]);
  assert.equal(answer.revision, 3);
  assert.equal(answer.digest, undefined);
  assert.equal((await createRouterClient(router).payeeTerms({ payee: PAYEE, digest: true })).digest, mandateDigest(policy));
  assert.deepEqual(answer.terms?.destinations.map(d => d.address), [PAYEE, PAYEE]);
  await assert.rejects(createRouterClient(router).payeeTerms({ payee: "Not An Account" }));
  const all = { canSign: true, canPropose: true, canVote: true, canExecute: true, canManage: true };
  assert.equal(mayCall(all, "payeeTerms"), false, "gateway-only, like ownerIdentity");
  assert.equal(appScopesCover(AppScope.options, "payeeTerms"), false);
});

/** A gateway serving the payee route for the owner's agent and another wallet's. */
async function harness(t: import("node:test").TestContext) {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "payee-policy-")); process.chdir(dir);
  const agents: AgentEntry[] = [
    { name: AGENT, owner: OWNER, port: 1, area: "payables", executor: true },
    { name: "own-000000000000000000000002", owner: "other.near", port: 2, area: "payables", executor: true },
  ];
  const state = {
    keys: { [OWNER]: "FullAccess", [PAYEE]: "FullAccess" } as Record<string, KeyState>, keysDown: false,
    agentId: AGENT_ID as string | null, owned: true, identityDown: false, termsDown: false,
    terms: (payee: string, digest: boolean): unknown => payeeTerms(policyView(policy, 4) as never, payee, state.agentId ?? AGENT_ID, new Date(), { digest }),
    mayUse: (_key: string) => true,
  };
  const termReads: { agent: string; payee: string; digest: boolean }[] = [];
  const server = createServer(async (req, res) => { try {
    if (!await payeePolicyRoutes(req, res, new URL(req.url!, "http://x").pathname, HOST, ".app-access", agents, {
      keyState: async (account, key) => {
        if (state.keysDown) throw new Error("rpc down");
        const expected = account === OWNER ? ownerKey : account === PAYEE ? payeeKey : null;
        return expected && key === expected.publicKey.toString() ? state.keys[account] ?? "absent" : "absent";
      },
      walletOwner: async (account, agent) => {
        if (state.identityDown) throw new Error("agent down");
        return agent.owner === account && state.owned ? { agentId: state.agentId } : null;
      },
      readTerms: async (agent, payee, digest) => { termReads.push({ agent: agent.name, payee, digest }); if (state.termsDown) throw new Error("agent down"); return state.terms(payee, digest); },
      mayUse: key => state.mayUse(key) })) { res.writeHead(404); res.end("{}"); }
  } catch (e) { sendFailure(res, e); } });
  const port = await listen(server);
  t.after(async () => { await close(server); process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); });
  const ask = async (d?: object, r?: object) => call(port, PAYEE_POLICY_PATH, "POST", { disclosure: d ?? await disclosure(), read: r ?? await read() });
  const logged = () => {
    const files = existsSync(join(dir, ".app-access")) ? readdirSync(join(dir, ".app-access")).filter(f => f.startsWith("access-")) : [];
    return files.flatMap(f => readFileSync(join(dir, ".app-access", f), "utf8").trim().split("\n").map(line => JSON.parse(line)));
  };
  return { port, state, termReads, ask, logged };
}

test("a payee reads the terms the owner disclosed to them, from the agent's current policy, with nothing else", async t => {
  const { ask, termReads, logged } = await harness(t);
  const answer = await ask();
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const proof = payeePolicyProof.parse(answer.body);
  assert.deepEqual({ ...proof, policy: { ...proof.policy, observedAt: "" } }, {
    host: HOST, owner: OWNER, agent: AGENT, disclosureExpiresAt: proof.disclosureExpiresAt,
    policy: { ...payeeTerms(policyView(policy, 4) as never, PAYEE, AGENT_ID), observedAt: "" } });
  assert.deepEqual(answer.body, proof, "the wire carries exactly the published fields");
  assert.equal("digest" in answer.body.policy, false, "no mandate digest without the owner's opt-in");
  assert.deepEqual(termReads, [{ agent: AGENT, payee: PAYEE, digest: false }]);
  assert.deepEqual(logged().map(({ event, owner, agent, payee, revision }) => ({ event, owner, agent, payee, revision })),
    [{ event: "payee-policy", owner: OWNER, agent: AGENT, payee: PAYEE, revision: 4 }]);
});

test("the mandate digest is answered only when the owner's signed disclosure opts in", async t => {
  const { ask, state, termReads } = await harness(t);
  const opted = await ask(await disclosure({ discloseDigest: true }));
  assert.equal(opted.status, 200, JSON.stringify(opted.body));
  assert.equal(payeePolicyProof.parse(opted.body).policy.digest, mandateDigest(policy));
  assert.deepEqual(termReads.map(r => r.digest), [true]);

  // An agent that answers the digest unasked: the gateway drops it unless the owner opted in.
  const honest = state.terms;
  state.terms = payee => honest(payee, true);
  const unasked = await ask();
  assert.equal(unasked.status, 200);
  assert.equal("digest" in unasked.body.policy, false);
  assert.ok(!JSON.stringify(unasked.body).includes(mandateDigest(policy).replace(/^sha256:/, "")), "never the mandate digest");

  // The opt-in can't be added to a disclosure the owner signed without it.
  const plain = await disclosure();
  const added = `${plain.message.slice(0, -1)},"discloseDigest":true}`;
  const forged = await ask({ ...plain, message: added });
  assert.deepEqual([forged.status, forged.body.error], [403, "The signature doesn't match the disclosure."]);
  const misplaced = await ask({ ...plain, message: plain.message.replace('"payee"', '"discloseDigest":true,"payee"') });
  assert.equal(misplaced.status, 400, "not canonical");
});

test("fields the agent adds beyond the published terms never reach the payee", async t => {
  const { ask, state } = await harness(t);
  const honest = state.terms;
  state.terms = (payee, digest) => {
    const terms = honest(payee, digest) as { terms: object };
    return { ...terms, budget: { daily_usd: "50" }, terms: { ...terms.terms, payees: ["bob.near"] } };
  };
  const answer = await ask();
  assert.equal(answer.status, 200);
  const text = JSON.stringify(answer.body);
  assert.ok(!text.includes("bob.near") && !text.includes("daily_usd"), text);
});

test("each signature, text, key and identity is checked before the agent is asked anything", async t => {
  const { ask, termReads, state } = await harness(t);
  const stranger = generateKey();
  const refused = async (d: object | undefined, r: object | undefined, status: number, error: RegExp, why: string) => {
    const answer = await ask(d, r);
    assert.equal(answer.status, status, `${why}: ${JSON.stringify(answer.body)}`);
    assert.match(answer.body.error, error, why);
  };
  await refused({}, undefined, 400, /Send the owner's signed disclosure and the payee's signed read/, "unsigned");
  await refused(await read(), undefined, 400, /isn't a canonical payee disclosure/, "a read in the disclosure's place");
  await refused(undefined, await disclosure(), 400, /isn't a canonical payee read/, "a disclosure in the read's place");
  await refused(await disclosure({ host: "other.test" }), undefined, 400, /names another platform host/, "disclosure host");
  await refused(undefined, await read({ host: "other.test" }), 400, /names another platform host/, "read host");
  await refused({ ...await disclosure({}, stranger), publicKey: ownerKey.publicKey.toString() }, undefined, 403, /doesn't match the disclosure/,
    "disclosure signed by another key than it names");
  await refused(undefined, { ...await read({}, stranger), publicKey: payeeKey.publicKey.toString() }, 403, /doesn't match the read/,
    "read signed by another key than it names");
  await refused(await disclosure({}, stranger), undefined, 403, /not a full-access key of owner\.near/, "disclosure signed by a key the owner doesn't hold");
  await refused(undefined, await read({}, stranger), 403, /not a full-access key of alice\.near/, "read signed by a key the payee doesn't hold");
  await refused(await disclosure({ owner: "other.near" }, stranger), undefined, 403, /not a full-access key of other\.near/, "another wallet's key");
  await refused(undefined, await read({ payee: "bob.near" }), 400, /names another payee or agent/, "a read for another payee");
  await refused(undefined, await read({ agent: "own-000000000000000000000002" }), 400, /names another payee or agent/, "a read for another agent");
  await refused(await disclosure({ expiresAt: inMinutes(-1) }), undefined, 400, /disclosure has expired/, "expired disclosure");
  await refused(await disclosure({ expiresAt: inMinutes(367 * 24 * 60) }), undefined, 400, /at most 366 days/, "disclosure too long");
  await refused(undefined, await read({ expiresAt: inMinutes(-1) }), 400, /read has expired/, "expired read");
  await refused(undefined, await read({ expiresAt: inMinutes(61) }), 400, /at most an hour/, "read too long");
  const recipient = await signed(payeeDisclosureMessage({ host: HOST, owner: OWNER, agent: AGENT, agentId: AGENT_ID, payee: PAYEE, expiresAt: inMinutes(60) }), ownerKey, OWNER, "other.test");
  await refused(recipient, undefined, 403, /doesn't match the disclosure/, "signed for another recipient");
  state.keys[OWNER] = "FunctionCall";
  await refused(undefined, undefined, 403, /not a full-access key of owner\.near/, "an owner key since reduced to function-call");
  state.keys[OWNER] = "FullAccess"; state.keys[PAYEE] = "absent";
  await refused(undefined, undefined, 403, /not a full-access key of alice\.near/, "a payee key since removed");
  state.keys[PAYEE] = "FullAccess";
  await refused(await disclosure({ agent: "own-000000000000000000000003" }), await read({ agent: "own-000000000000000000000003" }), 404, /No agent of owner\.near named/, "no such agent");
  await refused(await disclosure({ owner: "other.near", agent: "own-000000000000000000000002" }), await read({ agent: "own-000000000000000000000002" }), 403,
    /not a full-access key of other\.near/, "another wallet's agent, with this owner's key");
  state.owned = false;
  await refused(undefined, undefined, 404, /No agent of owner\.near named/, "the agent's server reports another owner");
  state.owned = true; state.agentId = "id-replacement";
  await refused(undefined, undefined, 409, /was replaced/, "a replaced agent isn't covered");
  state.agentId = null;
  await refused(undefined, undefined, 409, /was replaced/, "an agent not created");
  assert.deepEqual(termReads, [], "nothing reached the agent's policy read");
});

test("an unanswered check is 503 and reveals nothing; a busy address is 429; only POST answers", async t => {
  const { ask, port, state, termReads } = await harness(t);
  state.keysDown = true;
  assert.deepEqual([(await ask()).status, termReads.length], [503, 0]);
  state.keysDown = false; state.identityDown = true;
  assert.deepEqual([(await ask()).status, termReads.length], [503, 0]);
  state.identityDown = false; state.termsDown = true;
  assert.equal((await ask()).status, 503);
  state.termsDown = false; state.terms = () => ({ agentId: "id-other" });
  assert.equal((await ask()).status, 503, "an answer that doesn't parse as the published terms is not forwarded");
  state.terms = payee => payeeTerms(policyView(policy) as never, payee, "id-replacement");
  assert.equal((await ask()).status, 409, "the agent's read names another provider ID than the disclosure");
  state.mayUse = () => false;
  assert.equal((await ask()).status, 429);
  assert.equal((await call(port, PAYEE_POLICY_PATH, "GET")).status, 405);
});

test("the payee client sends the two signed texts to the platform host and parses the proof", async t => {
  const { port } = await harness(t);
  const client = payeeClient({ base: `http://127.0.0.1:${port}` });
  const result = await client.policyProof({ disclosure: await disclosure(), read: await read() });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.policy.terms?.agreed, true);
  const refused = await client.policyProof({ disclosure: await disclosure(), read: await read({ payee: "bob.near" }) });
  assert.deepEqual(refused.ok ? null : [refused.kind, (refused as { status?: number }).status], ["refused", 400]);
  const forbidden = await client.policyProof({ disclosure: await disclosure({}, generateKey()), read: await read() });
  assert.equal(forbidden.ok ? null : forbidden.kind, "forbidden");
  assert.throws(() => client.policyProof({ disclosure: { message: "x" }, read: {} } as never), "an incomplete request is refused before sending");
  const garbled = payeeClient({ base: "http://x", fetch: async () => Response.json({ host: HOST }) });
  assert.deepEqual(await garbled.policyProof({ disclosure: await disclosure(), read: await read() }), { ok: false, kind: "unavailable" }, "a read: never unknown");
});
