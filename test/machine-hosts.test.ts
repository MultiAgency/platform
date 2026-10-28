import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoSession } from "../src/gateway/demo-hosts.js";
import { AppConfirms } from "../src/gateway/app-confirm.js";
const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
const close = (server: Server) => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
test("real shared gateway isolates access sessions, credentials and agent assignments by host", { timeout: 30000 }, async t => {
  const root = process.cwd(), dir = mkdtempSync(join(tmpdir(), "machine-hosts-")), secret = "offline-shared-host-secret-1234567890123456";
  const chain = createServer((req, res) => {
    let body = ""; req.on("data", c => body += c); req.on("end", () => {
      const { id, params } = JSON.parse(body);
      const dao = { roles: [{ name: "council", kind: { Group: ["owner.near"] }, permissions: ["*:*"] }], proposal_bond: "0" };
      const answer = params.account_id === "dao.near" ? { result: { result: [...Buffer.from(JSON.stringify(dao))], logs: [], block_height: 1, block_hash: "11111111111111111111111111111111" } }
        : { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: params.account_id } }, code: -32000, message: "Server error" } };
      res.end(JSON.stringify({ jsonrpc: "2.0", id, ...answer }));
    });
  });
  const upstream = createServer((req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ json: req.url === "/rpc/ownerIdentity"
    ? { agentId: "provider-agent", owner: { type: "near", account_id: "owner.near" } } : { ok: true } })));
  const chainPort = await listen(chain), agentPort = await listen(upstream);
  const probe = createServer(), port = await listen(probe); await close(probe);
  writeFileSync(join(dir, "dashboard.json"), JSON.stringify({ host: "one.test", selfService: true,
    hosts: { "one.test": { demo: "treasury", agents: ["portfolio", "dao"] }, "two.test": { demo: "treasury", agents: ["portfolio"] }, "empty.test": { demo: "treasury", agents: [], hostedAreas: ["treasury"] } },
    agents: [{ name: "portfolio", owner: "owner.near", area: "treasury", port: agentPort }, { name: "dao", owner: "dao.near", area: "treasury", port: agentPort + 1 }] }));
  const child = spawn(join(root, "node_modules/.bin/tsx"), [join(root, "src/gateway/server.ts")], { cwd: dir,
    env: { ...process.env, SESSION_SECRET: secret, PORT: String(port), NEAR_RPC_URL: `http://127.0.0.1:${chainPort}` }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stderr!.on("data", chunk => output += chunk);
  t.after(async () => { const ended = child.exitCode === null && child.signalCode === null ? new Promise<void>(resolve => child.once("exit", () => resolve())) : Promise.resolve(); child.kill(); await ended; await close(chain); await close(upstream); rmSync(dir, { recursive: true, force: true }); });
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("gateway startup timeout")), 10000); child.stdout!.on("data", d => { if (d.toString().includes("on port")) { clearTimeout(timer); resolve(); } }); child.once("exit", () => { clearTimeout(timer); reject(new Error(`gateway exited: ${output}`)); }); });
  const call = (host: string, path: string, options: { method?: string; cookieHost?: string; account?: string; token?: string; body?: object; origin?: string } = {}) => new Promise<{ status: number; data: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: { host, "content-type": "application/json",
      ...(options.account && { cookie: demoSession(secret, options.cookieHost ?? host).open(options.account).split(";")[0]! }),
      ...(options.token && { authorization: `Bearer ${options.token}` }), ...(options.origin && { origin: options.origin }) } }, res => {
      let body = ""; res.on("data", c => body += c); res.on("end", () => resolve({ status: res.statusCode!, data: JSON.parse(body) }));
    }); req.setTimeout(10000, () => req.destroy(new Error(`Timed out: ${host}${path}`))); req.on("error", reject); req.end(options.body ? JSON.stringify(options.body) : undefined);
  });
  const endpoint = "/gw/machine-credentials/portfolio", input = { label: "host test", scopes: ["read"], ttlSeconds: 60 };
  const issued = await call("one.test", endpoint, { method: "POST", account: "owner.near", body: input }); assert.equal(issued.status, 201);
  const rpc = "/machine/v1/a/portfolio/rpc/instance";
  assert.equal((await call("one.test", rpc, { method: "POST", token: issued.data.token, body: {} })).status, 200);
  assert.equal((await call("two.test", rpc, { method: "POST", token: issued.data.token, body: {} })).status, 401);
  assert.equal((await call("two.test", endpoint, { account: "owner.near", cookieHost: "one.test" })).status, 401);
  assert.deepEqual((await call("two.test", endpoint, { account: "owner.near" })).data.credentials, []);
  assert.equal((await call("empty.test", endpoint, { account: "owner.near" })).status, 403);
  assert.equal((await call("one.test", endpoint, { account: "other.near" })).status, 403);
  assert.equal((await call("one.test", endpoint, { method: "POST", account: "owner.near", origin: "https://two.test", body: input })).status, 403);
  assert.equal((await call("foreign.test", rpc, { method: "POST", token: issued.data.token, body: {} })).status, 421);
  assert.equal((await call("one.test", "/gw/machine-credentials/dao", { method: "POST", account: "owner.near", body: input })).status, 409);
  assert.equal((await call("one.test", "/gw/machine-credentials/dao", { method: "POST", account: "dao.near", body: input })).status, 409);
  assert.equal((await call("one.test", "/a/portfolio/rpc/instance", { method: "POST", token: issued.data.token, body: {} })).status, 401);
  const view = await call("one.test", "/gw/access-session", { account: "owner.near" });
  assert.deepEqual(view.data.agents.map((a: { name: string }) => a.name), ["portfolio", "dao"]);
  assert.equal(view.data.viewer.access.portfolio.canExecute, false);

  // A confirm link is served on the host the app called, as `/apps/v1` is, and only there.
  const { token } = new AppConfirms(join(dir, ".app-access")).hold({ deployment: "staging", host: "one.test", organization: "org_1", owner: "owner.near",
    agent: "portfolio", agentId: "provider-agent", consent: "c", correlationId: "c-host", type: "agent_freeze", action: { type: "agent_freeze" }, policy: null,
    summary: null, expiresAt: new Date(Date.now() + 60_000).toISOString(), intent: { standard: "nep366", payload: {} },
    signer: { type: "near", account_id: "owner.near", public_key: "ed25519:k" } });
  const raw = (host: string, path: string, method = "GET") => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host, "content-type": "application/json" } }, res => {
      let body = ""; res.on("data", c => body += c); res.on("end", () => resolve({ status: res.statusCode!, body }));
    }); req.on("error", reject); req.end(method === "POST" ? "{}" : undefined);
  });
  const read = await raw("one.test", `/confirm/v1/${token}`);
  assert.equal(read.status, 200, read.body);
  assert.equal(JSON.parse(read.body).agent, "portfolio");
  assert.equal((await raw("one.test", `/confirm/v1/${token}/open`, "POST")).status, 403, "opening still needs the owner's signature");
  const elsewhere = await raw("two.test", `/confirm/v1/${token}`);
  assert.equal(elsewhere.status, 404, "another host doesn't serve this link");
});
