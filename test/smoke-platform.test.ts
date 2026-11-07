import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { platformChecks } from "../src/smoke-platform.js";

/** A stand-in for a platform host, answering as a deployed one does; `change` makes one route answer otherwise. */
async function host(t: { after: (fn: () => void) => void }, change: (req: IncomingMessage, res: ServerResponse) => boolean = () => false) {
  const page = `<!DOCTYPE html><html><head><script defer src="/static/js/lib.1.js"></script><script defer src="/static/js/confirm.2.js"></script>`
    + `<link href="/static/css/c.3.css" rel="stylesheet"></head><body></body></html>`;
  const server = createServer((req, res) => {
    if (change(req, res)) return;
    const path = new URL(req.url!, "http://x").pathname;
    const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (path === "/health") return json(200, { ok: true });
    if (path.startsWith("/apps/v1/")) return req.headers.origin ? json(403, { error: "Browsers can't call app access" }) : json(401, { error: "Missing credential" });
    if (/^\/confirm\/[A-Za-z0-9_-]{22}$/.test(path)) return res.writeHead(200, { "content-type": "text/html" }).end(page);
    if (path.startsWith("/confirm/dao/stop/"))
      return res.writeHead(404, { "content-type": "text/html", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" }).end("<html><p>No such request</p></html>");
    if (["/static/js/lib.1.js", "/static/js/confirm.2.js", "/static/css/c.3.css"].includes(path)) return res.writeHead(200).end("x");
    json(404, { error: "Not found" });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}
const failures = async (base: URL) => (await platformChecks(base)).filter(c => !c.ok).map(c => c.name);

test("platform smoke passes a host that answers as deployed, checking every asset the confirm page loads", async t => {
  const checks = await platformChecks(await host(t));
  assert.deepEqual(checks.filter(c => !c.ok), []);
  assert.deepEqual(checks.filter(c => c.name.startsWith("confirm asset")).map(c => c.name),
    ["confirm asset /static/js/lib.1.js", "confirm asset /static/js/confirm.2.js", "confirm asset /static/css/c.3.css"]);
});

test("platform smoke fails a confirm page that would load blank, and a host that serves more than app access", async t => {
  // The page's script is missing: the page loads with no UI (staging, before its package carried the build manifest).
  assert.deepEqual(await failures(await host(t, (req, res) => req.url === "/static/js/confirm.2.js" && !!res.writeHead(404).end())),
    ["confirm asset /static/js/confirm.2.js"]);
  // No page at all.
  assert.deepEqual(await failures(await host(t, (req, res) => req.url!.startsWith("/confirm/smoke") && !!res.writeHead(404).end())),
    ["confirm page", "confirm page loads its scripts"]);
  // The prototype's sign-in on a platform host, and app access open without a credential.
  assert.deepEqual(await failures(await host(t, (req, res) => req.url === "/gw/challenge" && !!res.writeHead(200).end("{}"))),
    ["platform serves no /gw/challenge"]);
  assert.deepEqual(await failures(await host(t, (req, res) => req.url === "/apps/v1/agents/smoke" && !req.headers.origin && !!res.writeHead(200).end("{}"))),
    ["app access needs a credential"]);
  // A stop page that runs a script.
  assert.deepEqual(await failures(await host(t, (req, res) => req.url!.startsWith("/confirm/dao/stop/") && !!res.writeHead(404, { "content-security-policy": "default-src 'none'" }).end("<script></script>"))),
    ["unknown DAO stop page runs no script"]);
});
