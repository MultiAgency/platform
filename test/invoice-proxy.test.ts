import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request, type Server } from "node:http";
import type { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { forwardInvoice } from "../src/gateway/invoice-proxy.js";
const listen = (s: Server) => new Promise<number>(resolve => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
test("invoice proxy streams the original identity once, strips dashboard sessions and never follows redirects or retries loss", async t => {
  let calls = 0; const seen: { path?: string; body: string; cookie?: string; origin?: string }[] = [];
  const backend = createServer((req, res) => { let body = ""; req.on("data", x => body += x).on("end", () => {
    calls++; seen.push({ path: req.url, body, cookie: req.headers.cookie, origin: req.headers.origin });
    if (req.url === "/lost") return req.socket.destroy();
    if (req.url === "/redirect") return res.writeHead(307, { location: "https://elsewhere.invalid/" }).end();
    res.writeHead(200, { "content-type": "application/json" }).end(body);
  }); });
  const backendPort = await listen(backend);
  // Only the transport is adapted to local HTTP; routing and streaming use production code.
  const transport = ((_target: URL, options: object, callback: Parameters<typeof request>[2]) => request({ ...options, hostname: "127.0.0.1", port: backendPort }, callback)) as unknown as typeof httpsRequest;
  const gateway = createServer((req, res) => forwardInvoice(req, res, "https://fixed-backend.invalid", req.url!, transport));
  const port = await listen(gateway); t.after(() => { backend.close(); gateway.close(); });
  const headers = { origin: "https://invoices.multiagency.ai", cookie: "__Host-demo_session=private; invoices_session=payee", "content-type": "application/json" };
  const body = '{"submission":"retained-id","amount":"1"}';
  const response = await fetch(`http://127.0.0.1:${port}/api/invoices?record=exact`, { method: "POST", headers, body });
  assert.equal(await response.text(), body); assert.equal(calls, 1);
  assert.deepEqual(seen[0], { path: "/api/invoices?record=exact", body, cookie: "invoices_session=payee", origin: headers.origin });
  const anonymous = await fetch(`http://127.0.0.1:${port}/api/session`);
  assert.equal(anonymous.status, 200);
  assert.equal(seen.at(-1)?.cookie, undefined, "signed-out intake works without a Cookie header");
  for (const path of ["/lost", "/redirect"]) {
    const before: number = calls;
    const answer = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers, body });
    assert.equal(answer.status, 502); assert.equal(answer.headers.get("location"), null);
    assert.equal(calls, before + 1); assert.match(await answer.text(), /original record/);
  }
});

test("contributor timeout after acceptance preserves ambiguity and never replays", async t => {
  let accepted = 0;
  const backend = createServer((req, _res) => { req.resume(); req.on("end", () => { accepted++; }); });
  const backendPort = await listen(backend);
  const transport = ((_target: URL, options: object, callback: Parameters<typeof request>[2]) => request({ ...options, hostname: "127.0.0.1", port: backendPort }, callback)) as unknown as typeof httpsRequest;
  const gateway = createServer((req, res) => forwardInvoice(req, res, "https://fixed-backend.invalid", "/api/invoices", transport, "invoices_session", 50));
  const port = await listen(gateway);
  t.after(() => { backend.closeAllConnections(); backend.close(); gateway.closeAllConnections(); gateway.close(); });
  const answer = await fetch(`http://127.0.0.1:${port}`, { method: "POST", body: '{"submission":"original"}', signal: AbortSignal.timeout(1500) });
  assert.equal(answer.status, 502); assert.match(await answer.text(), /may have been accepted.*original record/);
  assert.equal(accepted, 1);
});

test("invoice proxy strips client-sent gateway headers, as every route to an agent does", async t => {
  const seen: Record<string, unknown>[] = [];
  const backend = createServer((req, res) => { seen.push(req.headers); req.resume(); req.on("end", () => res.writeHead(200).end("{}")); });
  const backendPort = await listen(backend);
  const transport = ((_target: URL, options: object, callback: Parameters<typeof request>[2]) => request({ ...options, hostname: "127.0.0.1", port: backendPort }, callback)) as unknown as typeof httpsRequest;
  const gateway = createServer((req, res) => forwardInvoice(req, res, "https://fixed-backend.invalid", req.url!, transport));
  const port = await listen(gateway); t.after(() => { backend.close(); gateway.close(); });
  await fetch(`http://127.0.0.1:${port}/api/session`, { headers: { "x-gateway-actor": "app:staging:org_1", "X-Gateway-Other": "1" } });
  assert.deepEqual(Object.keys(seen[0]!).filter(name => name.startsWith("x-gateway")), []);
});
