import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request, type Server } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machineRoutes } from "../src/gateway/machine-routes.js";
import { sendFailure } from "../src/http.js";

const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
const close = (server: Server) => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
function call(port: number, path: string, method = "GET", token?: string, body?: object, headers = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { ...headers, ...(token && { authorization: `Bearer ${token}` }), "content-type": "application/json" } }, res => {
      let text = ""; res.on("data", chunk => text += chunk); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    }); req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}

test("shared access routes bind host/owner/agent, sanitize forwarding and retain outage revocation", async t => {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "shared-machine-")); process.chdir(dir);
  let account: string | null = "owner.near", host = "one.test", providerId = "provider-id", unavailable = false;
  let waitIdentity: Promise<void> | undefined, identityStarted: (() => void) | undefined;
  const forwarded: { headers: object; body: string; path: string }[] = [];
  const upstream = createServer((req, res) => { let body = ""; req.on("data", c => body += c); req.on("end", () => {
    forwarded.push({ headers: req.headers, body, path: req.url! }); res.setHeader("content-type", "application/json"); res.end('{"json":{"ok":true}}');
  }); });
  const agent = { name: "portfolio", owner: "owner.near", port: await listen(upstream), area: "treasury" as const, executor: true };
  let selected = [agent];
  const server = createServer(async (req, res) => { try {
    if (!await machineRoutes(req, res, req.url!, host, selected, () => account, () => false)) { res.writeHead(404); res.end('{}'); }
  } catch (e) { sendFailure(res, e); } });
  const port = await listen(server);
  t.after(async () => { await close(server); await close(upstream); process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); });
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname.startsWith("/rpc/")) {
      identityStarted?.(); await waitIdentity;
      return unavailable ? new Response("", { status: 503 }) : Response.json({ json: { agentId: providerId, owner: { type: "near", account_id: agent.owner } } });
    }
    return Response.json({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: agent.owner } }, code: -32000, message: "Server error" } });
  });
  const endpoint = "/gw/machine-credentials/portfolio", rpc = "/machine/v1/a/portfolio/rpc/";
  const issued = await call(port, endpoint, "POST", undefined, { label: "reader", scopes: ["read"], ttlSeconds: 3600 });
  assert.equal(issued.status, 201); const token = issued.body.token, id = issued.body.credential.id;
  assert.equal((await call(port, rpc + "overview", "POST", token, { json: null }, { "x-gateway": "forged", "x-gateway-owner": "forged" })).status, 200);
  assert.equal(forwarded.length, 1);
  assert.equal((forwarded[0]!.headers as any).authorization, undefined);
  assert.equal((forwarded[0]!.headers as any)["x-gateway"], undefined);
  assert.equal((forwarded[0]!.headers as any)["x-gateway-owner"], undefined);
  for (const procedure of ["rebalance", "executePlan", "sweep", "owner/prepare", "autopilot/tick"]) assert.equal((await call(port, rpc + procedure, "POST", token, {})).status, 403);
  assert.equal((await call(port, rpc + "overview", "POST", token, {}, { cookie: "x=y" })).status, 403);
  // A browser at the dashboard origin is refused; the dashboard's server calls with the bearer token and no Origin.
  assert.equal((await call(port, rpc + "overview", "POST", token, {}, { origin: "https://dev.multiagency.ai" })).status, 403);
  host = "two.test";
  assert.equal((await call(port, endpoint)).body.credentials.length, 0);
  assert.equal((await call(port, `${endpoint}/${id}`, "DELETE")).status, 404);
  assert.equal((await call(port, rpc + "overview", "POST", token, {})).status, 401);
  host = "one.test"; selected = [];
  assert.equal((await call(port, rpc + "overview", "POST", token, {})).status, 403); selected = [agent];
  account = "other.near"; assert.equal((await call(port, endpoint)).status, 403); account = agent.owner;
  providerId = "replacement";
  assert.equal((await call(port, rpc + "overview", "POST", token, {})).status, 403); providerId = "provider-id";
  unavailable = true;
  assert.equal((await call(port, endpoint)).status, 200);
  assert.equal((await call(port, rpc + "overview", "POST", token, {})).status, 403);
  unavailable = false;
  // A revoke while the fresh ownership read is in flight wins before forwarding.
  let release!: () => void;
  waitIdentity = new Promise<void>(resolve => release = resolve);
  const started = new Promise<void>(resolve => identityStarted = resolve);
  const pending = call(port, rpc + "overview", "POST", token, {}); await started;
  unavailable = true;
  assert.equal((await call(port, `${endpoint}/${id}`, "DELETE")).status, 200);
  unavailable = false; release();
  assert.equal((await pending).status, 403); waitIdentity = undefined; identityStarted = undefined;
  assert.equal(forwarded.length, 1);
  assert.equal((await call(port, endpoint)).body.credentials[0].revoked, true);
  const audit = readFileSync(join(dir, ".machine-auth/access.jsonl"), "utf8");
  assert.ok(audit.includes(id)); assert.ok(!audit.includes(token));
  const second = await call(port, endpoint, "POST", undefined, { label: "audit refusal", scopes: ["read"], ttlSeconds: 3600 });
  rmSync(join(dir, ".machine-auth/access.jsonl")); mkdirSync(join(dir, ".machine-auth/access.jsonl"));
  assert.equal((await call(port, rpc + "overview", "POST", second.body.token, {})).status, 500);
  assert.equal(forwarded.length, 1);
});
