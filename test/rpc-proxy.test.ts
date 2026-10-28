import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { forwardRpc, RPC_IDLE_TIMEOUT_MS } from "../src/gateway/rpc-proxy.js";
import { setTimeout as delay } from "node:timers/promises";
const listen = (s: Server) => new Promise<number>(resolve => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));

test("RPC stalls after acceptance time out without replay or claiming failure of the action", async t => {
  let accepted = 0;
  const backend = createServer((req, _res) => { req.resume(); req.on("end", () => { accepted++; }); });
  const port = await listen(backend);
  const gateway = createServer((req, res) => forwardRpc(req, res, { name: "fixture", owner: "owner.near", port, executor: true }, "pay", 50));
  const gatewayPort = await listen(gateway);
  t.after(() => { gateway.closeAllConnections(); gateway.close(); backend.closeAllConnections(); backend.close(); });
  const result = await fetch(`http://127.0.0.1:${gatewayPort}`, { method: "POST", body: '{"identity":"original"}', signal: AbortSignal.timeout(1500) });
  assert.equal(result.status, 502);
  assert.match(await result.text(), /may have been accepted.*original record/);
  assert.equal(accepted, 1);
});

test("RPC response streaming stays active beyond the inactivity window; disconnect closes upstream", async t => {
  let calls = 0, disconnected = false;
  const backend = createServer((_req, res) => {
    calls++;
    res.writeHead(200); res.write("observed\n");
    const timer = setInterval(() => res.write("observed\n"), 20);
    res.on("close", () => { clearInterval(timer); disconnected = true; });
  });
  const port = await listen(backend);
  const gateway = createServer((req, res) => forwardRpc(req, res, { name: "fixture", owner: "owner.near", port, executor: true }, "rebalance", 300));
  const gatewayPort = await listen(gateway);
  t.after(() => { gateway.closeAllConnections(); gateway.close(); backend.closeAllConnections(); backend.close(); });
  const controller = new AbortController();
  const result = await fetch(`http://127.0.0.1:${gatewayPort}`, { method: "POST", signal: controller.signal });
  assert.equal(result.status, 200);
  const reader = result.body!.getReader();
  const until = Date.now() + 450;
  while (Date.now() < until) assert.equal((await reader.read()).done, false);
  controller.abort();
  for (let i = 0; i < 100 && !disconnected; i++) await delay(10);
  assert.equal(disconnected, true);
  assert.equal(calls, 1);
});


test("RPC allows silent settlement before a response", async t => {
  assert.ok(RPC_IDLE_TIMEOUT_MS > 180_000, "must exceed a single provider settlement wait");
  const backend = createServer((_req, res) => { setTimeout(() => res.end("settled"), 80); });
  const port = await listen(backend);
  const gateway = createServer((req, res) => forwardRpc(req, res, { name: "fixture", owner: "owner.near", port, executor: true }, "pay", 300));
  const gatewayPort = await listen(gateway);
  t.after(() => { gateway.closeAllConnections(); gateway.close(); backend.closeAllConnections(); backend.close(); });
  const result = await fetch(`http://127.0.0.1:${gatewayPort}`, { method: "POST" });
  assert.equal(await result.text(), "settled");
});

test("a hold that throws answers 502 and releases nothing, instead of taking the gateway down", async t => {
  const backend = createServer((req, res) => { req.resume(); req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end('{"json":{"ok":true}}')); });
  const port = await listen(backend);
  const gateway = createServer((req, res) => forwardRpc(req, res, { name: "fixture", owner: "owner.near", port, executor: true }, "owner/prepare",
    undefined, "{}", "app:x:y", () => { throw new Error("App access directory must be private"); }));
  const gatewayPort = await listen(gateway);
  t.after(() => { gateway.closeAllConnections(); gateway.close(); backend.closeAllConnections(); backend.close(); });
  const result = await fetch(`http://127.0.0.1:${gatewayPort}`, { method: "POST", body: "{}" });
  assert.equal(result.status, 502);
  assert.doesNotMatch(await result.text(), /"ok"/, "the reply isn't released");
});
