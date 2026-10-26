import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoCrossSite, demoHost, demoSession, invoiceRoute } from "../src/gateway/demo-hosts.js";
import { generateKey, Near, type PrivateKey } from "near-kit";
import { issueChallenge, verifySignIn } from "../src/signin.js";
import { loadConfig } from "../src/gateway/config.js";
import { checkedDiscovery } from "./fixtures/discovery.js";
const req = (host: string, extra = {}, method = "GET") => ({ headers: { host, ...extra }, method }) as IncomingMessage;
const hosts = {
  "proto.multiagency.ai": { demo: "showcase" as const, agents: ["treasury", "payout"] },
  "treasury.multiagency.ai": { demo: "treasury" as const, agents: ["treasury"] },
  "payables.multiagency.ai": { demo: "payables" as const, agents: ["payout"] },
  "invoices.multiagency.ai": { demo: "invoices" as const, agents: ["payout"] },
};
test("host selection ignores forwarded authority and sessions cannot cross sibling hosts", () => {
  assert.equal(demoHost(req("unknown.test", { "x-forwarded-host": "proto.multiagency.ai" }), hosts), null);
  assert.equal(demoHost(req("proto.multiagency.ai"), hosts)?.demo, "showcase");
  const secret = "s".repeat(40);
  const a = demoSession(secret, "proto.multiagency.ai"), b = demoSession(secret, "treasury.multiagency.ai");
  const cookie = a.open("alice.near");
  assert.match(cookie, /^__Host-demo_session=/); assert.doesNotMatch(cookie, /Domain=/);
  assert.match(cookie, /HttpOnly; SameSite=Strict/); assert.match(cookie, /; Secure$/);
  assert.equal(a.account(req("proto.multiagency.ai", { cookie })), "alice.near");
  assert.equal(b.account(req("treasury.multiagency.ai", { cookie })), null);
  assert.equal(demoCrossSite(req("treasury.multiagency.ai", { origin: "https://proto.multiagency.ai" }, "POST"), "treasury.multiagency.ai"), true);
  assert.equal(demoCrossSite(req("treasury.multiagency.ai", { origin: "http://treasury.multiagency.ai" }, "POST"), "treasury.multiagency.ai"), true);
  assert.equal(demoCrossSite(req("treasury.multiagency.ai", { "sec-fetch-site": "same-site" }), "treasury.multiagency.ai"), false, "normal catalog links remain navigable");
});
const listen = (s: Server) => new Promise<number>(resolve => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
test("real gateway isolates host APIs, preserves Proto, and refuses writes without redirects or upstream calls", { timeout: 20000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "demo-hosts-"));
  let upstreamReads = 0, submissions = 0;
  const upstream = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/rpc/ownerIdentity") { upstreamReads++; return res.end(JSON.stringify({ json: { agentId: null, owner: null } })); }
    if (req.url?.endsWith("?redirect=1")) return res.writeHead(307, { location: "https://elsewhere.invalid" }).end();
    submissions++; res.end(JSON.stringify({ json: { original: req.url } }));
  });
  const portA = await listen(upstream);
  const upstreamB = createServer((_req, res) => { res.setHeader("content-type", "application/json"); upstreamReads++; res.end(JSON.stringify({ json: { agentId: null, owner: null } })); });
  const portB = await listen(upstreamB);
  const near = createServer((req, res) => { let text = ""; req.on("data", c => text += c).on("end", () => {
    const { id } = JSON.parse(text); res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: {} }, code: -32000, message: "Server error" } }));
  }); });
  const nearPort = await listen(near);
  const probe = createServer(); const port = await listen(probe); await new Promise<void>(r => probe.close(() => r()));
  const secret = "offline-host-tests-".repeat(3);
  const config = { host: "proto.multiagency.ai", hosts, walkthroughs: true, agents: [
    { name: "treasury", area: "treasury", owner: "alice.near", port: portA },
    { name: "payout", area: "payables", owner: "alice.near", port: portB, executor: false },
  ] };
  writeFileSync(join(dir, "dashboard.json"), JSON.stringify(config));
  const child = spawn(join(process.cwd(), "node_modules/.bin/tsx"), [join(process.cwd(), "src/gateway/server.ts")], { cwd: dir, env: { ...process.env, PORT: String(port), SESSION_SECRET: secret, NEAR_RPC_URL: `http://127.0.0.1:${nearPort}` }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { child.kill(); upstream.close(); upstreamB.close(); near.close(); rmSync(dir, { recursive: true, force: true }); });
  let errors = ""; child.stderr!.on("data", x => errors += x);
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error(errors)), 8000); child.stdout!.on("data", x => { if (String(x).includes("on port")) { clearTimeout(timer); resolve(); } }); });
  const call = (host: string, path: string, method = "GET", headers: Record<string,string> = {}, body = "") => new Promise<{ status: number; headers: Record<string, unknown>; text: string }>((resolve, reject) => {
    const r = request({ hostname: "127.0.0.1", port, path, method, headers: { host, ...headers } }, res => { let text = ""; res.on("data", x => text += x).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text })); }); r.on("error", reject); r.end(body);
  });
  for (const host of Object.keys(hosts)) {
    const answer = await call(host, "/gw/me"); assert.equal(answer.status, 200); assert.deepEqual(checkedDiscovery(JSON.parse(answer.text)).agents, []);
    // Every host names the hosts serving each app area, so pages link to the full app on this deployment.
    assert.deepEqual(JSON.parse(answer.text).apps, { treasury: "treasury.multiagency.ai", payables: "payables.multiagency.ai" });
    const challenge = await call(host, "/gw/challenge"); assert.equal(JSON.parse(challenge.text).recipient, host);
  }
  assert.equal(upstreamReads, 0, "signed-out views do not read agents");
  assert.match((await call("invoices.multiagency.ai", "/")).text, /Open the contributor link shared by the owner/, "a fresh installation lists no owners and never defaults to another intake");
  assert.equal((await call("invoices.multiagency.ai", "/", "POST", {}, '{"amount":"1"}')).status, 405);
  const page = await call("proto.multiagency.ai", "/"); assert.notEqual(page.status, 302); assert.equal(page.headers.location, undefined);
  assert.equal((await call("evil.test", "/gw/me", "GET", { "x-forwarded-host": "proto.multiagency.ai" })).status, 421);
  assert.equal((await call("evil.test", "/health")).status, 200);
  const cookie = demoSession(secret, "treasury.multiagency.ai").open("alice.near").split(";")[0]!;
  const me = await call("treasury.multiagency.ai", "/gw/me", "GET", { cookie });
  assert.deepEqual(Object.keys(checkedDiscovery(JSON.parse(me.text)).viewer!.access), ["treasury"]);
  const copied = await call("payables.multiagency.ai", "/gw/me", "GET", { cookie }); assert.equal(JSON.parse(copied.text).viewer, null);
  for (const [host, path, origin, status] of [
    ["treasury.multiagency.ai", "/a/payout/rpc/payout", "https://treasury.multiagency.ai", 404],
    ["treasury.multiagency.ai", "/a/treasury/rpc/payout", "https://payables.multiagency.ai", 403],
    ["unknown.test", "/a/treasury/rpc/payout", "https://unknown.test", 421],
    ["proto.multiagency.ai", "/follow/payment?invoice=abc", "https://proto.multiagency.ai", 405],
  ] as const) {
    const answer = await call(host, path, "POST", { cookie, origin }, '{"amount":"1"}');
    assert.equal(answer.status, status); assert.equal(answer.headers.location, undefined);
  }
  assert.equal(submissions, 0, "refused bodies never reach an agent");
  const read = await call("treasury.multiagency.ai", "/a/treasury/rpc/overview?json=%7B%22id%22%3A%22exact%22%7D", "GET", { cookie });
  assert.equal(read.status, 200);
  assert.equal(read.headers["cache-control"], "private, no-store");
  const redirect = await call("treasury.multiagency.ai", "/a/treasury/rpc/overview?redirect=1", "GET", { cookie });
  assert.equal(redirect.status, 502); assert.equal(redirect.headers.location, undefined);
  assert.equal(JSON.parse(read.text).json.original, '/rpc/overview?json=%7B%22id%22%3A%22exact%22%7D');
  for (const metadata of ["same-site", "cross-site"]) {
    const rejected = await call("treasury.multiagency.ai", "/a/treasury/rpc/payout", "POST", { cookie, "sec-fetch-site": metadata }, '{}');
    assert.equal(rejected.status, 403); assert.equal(rejected.headers.location, undefined);
  }
  assert.equal(submissions, 1, "only the authorized exact read reached the backend");
  assert.equal((await call("treasury.multiagency.ai", "/a/payout/follow/payment?invoice=abc")).status, 404);
  const direct = await call("treasury.multiagency.ai", "/a/treasury/follow/payment?invoice=abc");
  assert.equal(direct.headers.location, undefined, "record URLs are not rewritten to a different host or record");
});
test("reviewed shared config retains executor assignment and disallows mismatched host areas", () => {
  const config = loadConfig("deploy/shared-demos.json");
  assert.equal(config.agents.find(a => a.name === "payout")?.executor, false);
  assert.equal(config.agents.find(a => a.name === "treasury")?.executor, true);
  assert.equal(config.hosts?.["proto.multiagency.ai"]?.demo, "showcase");
  assert.doesNotMatch(readFileSync("deploy/shared-demos.json", "utf8"), /redirect_hosts/);
});

test("a real NEP-413 signature cannot authenticate to a sibling demo", async () => {
  const key = generateKey();
  const challenge = issueChallenge("proto.multiagency.ai");
  const near = new Near({ network: "mainnet", privateKey: key.secretKey as PrivateKey, defaultSignerId: "alice.near" });
  const signed = await near.signMessage({ ...challenge, nonce: Buffer.from(challenge.nonce, "base64") });
  let lookups = 0;
  await assert.rejects(verifySignIn({ ...signed, accountId: "alice.near", nonce: challenge.nonce }, "treasury.multiagency.ai", async () => { lookups++; return "FullAccess"; }), /signature/);
  assert.equal(lookups, 0);
});

test("demo configuration rejects cross-area access and unsafe intake origins", () => {
  const dir = mkdtempSync(join(tmpdir(), "demo-config-"));
  try {
    const original = JSON.parse(readFileSync("deploy/shared-demos.json", "utf8"));
    assert.deepEqual(original.hosts["treasury.multiagency.ai"].agents, ["treasury", "payout"]);
    const file = join(dir, "config.json");
    for (const change of [
      (c: typeof original) => { c.hosts["treasury.multiagency.ai"].agents = ["missing"]; },
      (c: typeof original) => { c.hosts["payables.multiagency.ai"].agents = ["treasury"]; },
      (c: typeof original) => { c.hosts["payables.multiagency.ai"].hostedAreas = ["treasury"]; },
      (c: typeof original) => { c.invoiceUpstream = "http://insecure.test"; },
      (c: typeof original) => { c.invoiceUpstream = "https://user:secret@upstream.test"; },
    ]) {
      const config = structuredClone(original); change(config); writeFileSync(file, JSON.stringify(config));
      assert.throws(() => loadConfig(file));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Invoices is the contributor-facing Payables entry with exact identities and no page-body forwarding", () => {
  for (const path of ["/", "/?workOrder=retained%2Fid", "/submit?workOrder=retained%2Fid", "/api/work-orders/retained/file", "/internal/agreements"]) {
    const url = new URL(path, "https://invoices.multiagency.ai");
    const expected = path.replace(/^\/submit/, "/");
    assert.equal(invoiceRoute("invoices", url, "GET"), expected);
    assert.equal(invoiceRoute("payables", url, "GET"), null);
    assert.equal(invoiceRoute("showcase", url, "GET"), null);
  }
  for (const path of ["/", "/?workOrder=retained", "/submit"]) {
    assert.equal(invoiceRoute("invoices", new URL(path, "https://invoices.multiagency.ai"), "POST"), null);
  }
  assert.equal(invoiceRoute("invoices", new URL("/workspace", "https://invoices.multiagency.ai"), "GET"), null);
});

test("shared infrastructure can start without the agency's experiment agents", () => {
  const config = loadConfig("deploy/multiagency.json");
  assert.equal(config.selfService, true);
  assert.deepEqual(config.agents, []);
  assert.deepEqual(config.hosts?.["payables.multiagency.ai"]?.hostedAreas, ["payables"]);
  assert.equal(config.invoiceUpstream, undefined, "fresh installations never inherit the agency intake");
});
