import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supplierEnvironment, supplierCookie } from "../src/gateway/hosted-supplier.js";
import { demoSession } from "../src/gateway/demo-hosts.js";
import { sessionToken } from "../src/signin.js";
import { randomBytes } from "node:crypto";
import { generateKey, Near, type PrivateKey } from "near-kit";
import { setupMessage } from "../src/contract/app-consent.js";
import { AppCredentials } from "../src/gateway/app-access.js";
import { checkedDiscovery } from "./fixtures/discovery.js";

const localFetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<Response>((resolve, reject) => {
  const req = request(new URL(url), init, res => {
    const chunks: Buffer[] = [];
    res.on("data", chunk => chunks.push(chunk)).on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode! })));
  });
  req.on("error", reject); req.end(init.body);
});
const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
for (const sharedHosts of [false, true]) test(`${sharedHosts ? "shared hosts" : "legacy host"}: hosted setup admits a new wallet, isolates its real child, and recovers its reservation after gateway restart`, { timeout: 60_000 }, async t => {
  const root = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "hosted-gateway-"));
  const secret = "offline-self-service-session-secret-123456789";
  const ownerKey = generateKey();
  const rpc = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => body += chunk).on("end", () => {
      const { id, params } = JSON.parse(body);
      const view = (value: unknown) => ({ result: { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: 1, block_hash: "11111111111111111111111111111111" } });
      const policy = { proposal_bond: "0", roles: [{ name: "council", kind: { Group: ["alice.near"] }, permissions: ["call:AddProposal"], vote_policy: {} }], default_vote_policy: { threshold: [1, 2] } };
      const key = { nonce: 1, permission: "FullAccess", block_height: 1, block_hash: "11111111111111111111111111111111" };
      const answer = params.request_type === "view_access_key" && params.account_id === "carol.near" && params.public_key === ownerKey.publicKey.toString() ? { result: key }
        : params.account_id === "team.sputnik-dao.near" ? view(policy) : params.account_id === "v1.signer" ? view("ed25519:11111111111111111111111111111111")
        : { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: params.account_id } }, code: -32000, message: "Server error" } };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, ...answer }));
    });
  });
  const rpcPort = await listen(rpc);
  const old = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ json: { agentId: null, owner: null } })));
  const oldPort = await listen(old);
  const probe = createServer(); const port = await listen(probe); await new Promise(resolve => probe.close(resolve));
  writeFileSync(join(dir, "dashboard.json"), JSON.stringify({ host: "fixture.test", selfService: true, walkthroughs: true,
    ...(sharedHosts && { hosts: {
      "fixture.test": { demo: "showcase", agents: ["existing"], hostedAreas: ["treasury", "payables"] },
      "payables.test": { demo: "payables", agents: [], hostedAreas: ["payables"] },
      "invoices.test": { demo: "invoices", agents: [], hostedAreas: ["payables"] },
    } }),
    agents: [{ name: "existing", owner: "existing.near", port: oldPort }] }));
  let child: ChildProcess;
  let diagnostics = "";
  const stop = async () => {
    if (child && child.exitCode === null) await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill(); });
  };
  t.after(async () => { await stop(); rpc.close(); old.close(); rmSync(dir, { recursive: true, force: true }); });
  const start = async () => {
    child = spawn(join(root, "node_modules/.bin/tsx"), [join(root, "src/gateway/server.ts")], { cwd: dir,
      env: { ...process.env, PORT: String(port), SESSION_SECRET: secret, NEAR_RPC_URL: `http://127.0.0.1:${rpcPort}` }, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr!.on("data", data => { diagnostics = (diagnostics + data.toString()).slice(-8000); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Gateway startup timed out")), 8_000);
      child.stdout!.on("data", data => { if (data.toString().includes("on port")) { clearTimeout(timer); resolve(); } });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Gateway exited ${code}`)); });
    });
  };
  const call = (path: string, account?: string, body?: unknown, origin?: string, host = "fixture.test") => localFetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(sharedHosts && { host }), ...(account && { cookie: sharedHosts ? demoSession(secret, host).open(account).split(";")[0]! : `dao_session=${sessionToken(account, secret)}` }), ...(origin && { origin }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  await start();
  const publicView = checkedDiscovery(await (await call("/gw/me")).json());
  assert.deepEqual(publicView.agents, []);
  assert.equal(publicView.viewer, null);
  const fresh = checkedDiscovery(await (await call("/gw/me", "alice.near")).json());
  assert.equal(fresh.viewer!.account, "alice.near");
  assert.deepEqual(fresh.agents, []);
  const input = { owner: "alice.near", kind: "wallet", area: "treasury" };
  assert.equal((await call("/gw/agents", undefined, input)).status, 401);
  assert.equal((await call("/gw/agents", "bob.near", input)).status, 403);
  assert.equal((await call("/gw/agents", "alice.near", input, "https://foreign.test")).status, 403);
  const first = await call("/gw/agents", "alice.near", input);
  assert.equal(first.status, 200);
  const { name } = await first.json();
  assert.deepEqual(await (await call("/gw/agents", "alice.near", input)).json(), { name });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    const view = checkedDiscovery(await (await call("/gw/me", "alice.near")).json());
    if (view.viewer!.access[name]) { ready = true; assert.equal(view.agents[0]!.invoices, null); break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, `real isolated child answers ownership checks: ${diagnostics}`);
  const instance = await call(`/a/${name}/rpc/instance`, "alice.near", {});
  assert.equal(instance.status, 200);
  assert.deepEqual((await instance.json()).json, { agentId: null, executor: true }, "parent's fixture AGENT_ID never leaks into new setup");
  assert.equal((await call(`/a/${name}/rpc/instance`, "bob.near", {})).status, 403);
  const forged = await call(`/a/${name}/rpc/owner/prepare`, "alice.near", { json: {
    signer: "wallet", action: { type: "agent_create", owner: { type: "near", account_id: "bob.near", public_key: "ed25519:key" } },
  } });
  assert.equal(forged.status, 400);
  assert.match(await forged.text(), /bound to its selected owner/);
  // App setup through the real gateway: the owner's signed setup text reserves the hosted agent under the same
  // self-service and host rules, and the setup consent reaches the new agent while it isn't created.
  const tokens = Object.fromEntries(["fixture.test", "payables.test"].map(host =>
    [host, new AppCredentials(join(dir, ".app-access")).issue({ deployment: "staging", host, label: "staging", days: 30 }).token]));
  const dashboard = (path: string, host: string, body?: unknown) => localFetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { host, authorization: `Bearer ${tokens[host]}`, "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }) });
  const signedSetup = async (host: string, area: "treasury" | "payables") => {
    const message = setupMessage({ host, deployment: "staging", organization: "org_1", owner: "carol.near", area, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() });
    const nonce = randomBytes(32);
    const signature = await new Near({ network: "mainnet", privateKey: ownerKey.secretKey as PrivateKey, defaultSignerId: "carol.near" }).signMessage({ message, recipient: host, nonce });
    return { message, nonce: nonce.toString("base64"), publicKey: signature.publicKey, signature: signature.signature };
  };
  const setup = await dashboard("/apps/v1/setup", "fixture.test", await signedSetup("fixture.test", "payables"));
  assert.equal(setup.status, 201, `${await setup.clone().text()} ${diagnostics}`);
  const { agent: carolAgent, consent: setupConsentRecord } = await setup.json() as { agent: string; consent: { agentId: string; scopes: string[] } };
  assert.match(carolAgent, /^own-[0-9a-f]{24}$/);
  const carolEntry = (JSON.parse(readFileSync(join(dir, ".hosted", "apps.json"), "utf8")).entries as { name: string; deployment?: string; organization?: string }[]).find(e => e.name === carolAgent);
  assert.deepEqual([carolEntry?.deployment, carolEntry?.organization], ["staging", "org_1"], "the app's setup reserves an Organization's own agent");
  assert.deepEqual([setupConsentRecord.agentId, setupConsentRecord.scopes], ["unborn", ["owner"]]);
  let created: unknown;
  for (let i = 0; i < 150; i++) {
    const identity = await dashboard(`/apps/v1/agents/${carolAgent}`, "fixture.test");
    if (identity.status === 200) { created = (await identity.json()).created; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(created, false, `the new hosted agent answers, not created yet: ${diagnostics}`);
  if (sharedHosts) {
    const wrongArea = await dashboard("/apps/v1/setup", "payables.test", await signedSetup("payables.test", "treasury"));
    assert.deepEqual([wrongArea.status, (await wrongArea.json()).error], [409, "This area is not available on this host"]);
  }
  const daoInput = { owner: "team.sputnik-dao.near", kind: "dao", area: "payables" };
  assert.equal((await call("/gw/agents", "bob.near", daoInput)).status, 403);
  const daoResponse = await call("/gw/agents", "alice.near", daoInput);
  assert.equal(daoResponse.status, 200);
  const daoName = (await daoResponse.json()).name;
  let daoSetup;
  for (let i = 0; i < 150; i++) {
    const response = await call(`/a/${daoName}/rpc/setup`, "alice.near", {});
    if (response.ok) { daoSetup = (await response.json()).json; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(daoSetup?.agentId, null);
  assert.equal(daoSetup?.dao.id, daoInput.owner);
  assert.equal(daoSetup?.dao.owner.account_id, "0".repeat(64));
  assert.equal(daoSetup?.dao.funded, false, "unfunded DAO owner account remains an explicit prerequisite");
  if (sharedHosts) {
    assert.equal((await call("/gw/agents", "alice.near", input, undefined, "payables.test")).status, 403);
    const paymentHost = checkedDiscovery(await (await call("/gw/me", "alice.near", undefined, undefined, "payables.test")).json());
    assert.equal(paymentHost.viewer!.access[name], undefined, "Treasury instance stays outside the payment host");
    assert.ok(paymentHost.viewer!.access[daoName], "the same owner-created payout instance is available on its assigned hosts");
    assert.deepEqual(await (await call("/gw/agents", "alice.near", daoInput, undefined, "payables.test")).json(), { name: daoName });
    assert.deepEqual((await (await call("/gw/me", "bob.near", undefined, undefined, "payables.test")).json()).agents, []);
  }
  let walletPayout: string | undefined;
  if (sharedHosts) {
    assert.equal((await call(`/i/${daoName}/`, undefined, undefined, undefined, "invoices.test")).status, 503, "uninitialized payout cannot serve invoices");
    const own = await call("/gw/agents", "alice.near", { owner: "alice.near", kind: "wallet", area: "payables" });
    assert.equal(own.status, 200); walletPayout = (await own.json()).name;
  }
  await stop();
  if (sharedHosts) {
    // Offline-created identities: no provider creation or owner action is submitted by this test.
    for (const [instance, id] of [[daoName, "a".repeat(64)], [walletPayout!, "b".repeat(64)]]) {
      const file = join(dir, ".hosted", `${instance}.env`);
      writeFileSync(file, readFileSync(file, "utf8") + `AGENT_ID=${id}\n`);
    }
  }
  await start();
  if (sharedHosts) {
    for (const instance of [daoName, walletPayout!]) {
      let page;
      for (let i = 0; i < 100; i++) {
        page = await call(`/i/${instance}/?workOrder=exact`, undefined, undefined, undefined, "invoices.test");
        if (page.status === 200) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(page?.status, 200, diagnostics);
      assert.match(await page!.text(), new RegExp(`/i/${instance}/invoice-browser.js`));
      const unsigned = await call(`/i/${instance}/api/session`, undefined, undefined, undefined, "invoices.test");
      assert.deepEqual(await unsigned.json(), { account: null, agreed: false });
      assert.equal((await call(`/i/${instance}/api/work-orders`, undefined, undefined, undefined, "invoices.test")).status, 401);
      assert.equal((await call(`/i/${instance}/internal/agreements`, undefined, undefined, undefined, "invoices.test")).status, 404);
    }
    const env = supplierEnvironment({ name: daoName, owner: daoInput.owner, kind: "dao", area: "payables", port: 9000, executor: true, envFile: "unused" }, "invoices.test", secret);
    const cookie = `${supplierCookie(daoName)}=${sessionToken("contributor.near", env.INVOICES_SESSION_SECRET!)}`;
    const read = (instance: string) => localFetch(`http://127.0.0.1:${port}/i/${instance}/api/work-orders`, { headers: { host: "invoices.test", cookie } });
    assert.deepEqual(await (await read(daoName)).json(), { orders: [] });
    assert.equal((await read(walletPayout!)).status, 401, "contributor sessions cannot cross owner instances");
    const renamed = cookie.replace(supplierCookie(daoName), supplierCookie(walletPayout!));
    const copied = await localFetch(`http://127.0.0.1:${port}/i/${walletPayout!}/api/work-orders`, { headers: { host: "invoices.test", cookie: renamed } });
    assert.equal(copied.status, 401, "renaming another instance's cookie cannot bypass its distinct signing key");
    const challenge = await call(`/i/${daoName}/api/signin/challenge`, undefined, {}, "https://invoices.test", "invoices.test");
    assert.equal(challenge.status, 200);
    assert.equal((await challenge.json()).recipient, "invoices.test");
    assert.equal((await call(`/i/own-${"f".repeat(24)}/`, undefined, undefined, undefined, "invoices.test")).status, 404);
  }
  assert.deepEqual(await (await call("/gw/agents", "alice.near", input)).json(), { name });
});

test("a hosted contributor entry's environment is pinned: changing it is a deliberate decision", () => {
  const env = supplierEnvironment({ name: `own-${"a".repeat(24)}`, owner: "alice.near", kind: "wallet", area: "payables", port: 9000, executor: true, envFile: "unused" }, "invoices.test", "pinned-gateway-secret");
  // A changed derivation signs every existing contributor session out (0.0.1 did so once, by decision, from 1.5.0's "supplier:").
  assert.deepEqual(env, { HOSTED_INVOICE_BASE: `/i/own-${"a".repeat(24)}`, INVOICES_PUBLIC_HOST: "invoices.test", INVOICES_HTTPS: "true",
    INVOICES_SESSION_COOKIE: `__Host-invoice_own-${"a".repeat(24)}`, INVOICES_SESSION_SECRET: "a4ca7d1fb98e4fe04d40572c985e71cc57f9711c60b0199760e0c3ce743afc9d" });
});
