import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { generateKey, Near, type PrivateKey } from "near-kit";
import { setupMessage } from "../src/contract/app-consent.js";
import { AppCredentials } from "../src/gateway/app-access.js";
import { AppConfirms } from "../src/gateway/app-confirm.js";
import { sessions } from "../src/signin.js";

const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
const HOST = "api.test";

/**
 * A real gateway with `config` on HOST, beside a chain stub where carol.near's key is a full-access key, an app
 * credential for deployment `staging`, and the owner's signed setup text for an area.
 */
async function startGateway(t: { after: (fn: () => Promise<void>) => void }, config: object) {
  const root = process.cwd(), dir = mkdtempSync(join(tmpdir(), "platform-host-"));
  const ownerKey = generateKey();
  const chain = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => body += chunk).on("end", () => {
      const { id, params } = JSON.parse(body);
      const key = { nonce: 1, permission: "FullAccess", block_height: 1, block_hash: "11111111111111111111111111111111" };
      const answer = params.request_type === "view_access_key" && params.account_id === "carol.near" && params.public_key === ownerKey.publicKey.toString()
        ? { result: key } : { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: params.account_id } }, code: -32000, message: "Server error" } };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, ...answer }));
    });
  });
  const chainPort = await listen(chain);
  const probe = createServer(), port = await listen(probe); await new Promise(resolve => probe.close(resolve));
  writeFileSync(join(dir, "dashboard.json"), JSON.stringify(config));
  const token = new AppCredentials(join(dir, ".app-access")).issue({ deployment: "staging", host: HOST, label: "staging", days: 30 }).token;
  let diagnostics = "";
  const secret = "offline-platform-host-secret-123456789012345";
  const child: ChildProcess = spawn(join(root, "node_modules/.bin/tsx"), [join(root, "src/gateway/server.ts")], { cwd: dir,
    env: { ...process.env, PORT: String(port), SESSION_SECRET: secret, NEAR_RPC_URL: `http://127.0.0.1:${chainPort}` },
    stdio: ["ignore", "pipe", "pipe"] });
  child.stderr!.on("data", data => { diagnostics = (diagnostics + data.toString()).slice(-8000); });
  t.after(async () => {
    if (child.exitCode === null) await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill(); });
    chain.close(); rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Gateway startup timed out")), 10_000);
    child.stdout!.on("data", data => { if (data.toString().includes("on port")) { clearTimeout(timer); resolve(); } });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Gateway exited ${code}: ${diagnostics}`)); });
  });
  const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
    new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: { host: HOST, "content-type": "application/json", ...init.headers } }, res => {
        let body = ""; res.on("data", c => body += c); res.on("end", () => resolve({ status: res.statusCode!, type: res.headers["content-type"] ?? "", body }));
      });
      req.on("error", reject); req.end(init.body === undefined ? undefined : JSON.stringify(init.body));
    });
  const app = (path: string, body?: unknown) => call(`/apps/v1${path}`, { headers: { authorization: `Bearer ${token}` }, body });
  const signedSetup = async (area: "treasury" | "payables") => {
    const message = setupMessage({ host: HOST, deployment: "staging", organization: "org_1", owner: "carol.near", area, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() });
    const nonce = randomBytes(32);
    const signature = await new Near({ network: "mainnet", privateKey: ownerKey.secretKey as PrivateKey, defaultSignerId: "carol.near" }).signMessage({ message, recipient: HOST, nonce });
    return { message, nonce: nonce.toString("base64"), publicKey: signature.publicKey, signature: signature.signature };
  };
  return { root, dir, secret, token, call, app, signedSetup, diagnostics: () => diagnostics };
}

/**
 * The platform host (`headless`): app access, the confirm page and its assets, nothing else. Every other route a
 * gateway has (sign-in, owner app and RPC, machine credentials, payee entry, skills) answers 404 before any session is
 * read; app setup is limited to the areas `appSetup` lists.
 */
test("a headless host serves only app access and the confirm page, and sets up only the listed areas", { timeout: 60_000 }, async t => {
  const { root, dir, token, call, app, signedSetup, diagnostics } = await startGateway(t, { host: HOST, headless: true, appSetup: ["payables"], agents: [] });
  const confirm = new AppConfirms(join(dir, ".app-access")).hold({ deployment: "staging", host: HOST, organization: "org_1", owner: "carol.near",
    agent: "own-000000000000000000000000", agentId: "provider-agent", consent: "c", correlationId: "c-platform", type: "agent_freeze",
    action: { type: "agent_freeze" }, policy: null, summary: null, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    intent: { standard: "nep366", payload: {} }, signer: { type: "near", account_id: "carol.near", public_key: "ed25519:k" } }).token;
  const absent = async (path: string, method = "GET") => {
    const answer = await call(path, { method, ...(method === "POST" && { body: {} }) });
    assert.deepEqual([answer.status, JSON.parse(answer.body)], [404, { error: "Not found" }], `${method} ${path}`);
  };

  assert.equal((await call("/health")).status, 200);
  for (const path of ["/", "/index.html", "/a/payout/", "/a/payout/access", "/gw/challenge", "/gw/me", "/gw/access-session",
    "/gw/machine-credentials/payout", "/i/payout/", "/skill.md", "/static", "/static/../index.html", "/static/../confirm.html"]) await absent(path);
  for (const path of ["/a/payout/rpc/overview", "/gw/session", "/gw/agents", "/machine/v1/a/payout/rpc/overview", "/static/js/x.js"]) await absent(path, "POST");

  // App access answers as on any host: a credential is required, and a browser is refused.
  assert.equal((await call("/apps/v1/agents/own-000000000000000000000000")).status, 401);
  assert.equal((await call("/apps/v1/agents/own-000000000000000000000000", { headers: { authorization: `Bearer ${token}`, origin: "https://app.test" } })).status, 403);
  assert.equal((await call("/apps/v1/agents/x", { headers: { host: "other.test", authorization: `Bearer ${token}` } })).status, 421);
  // The confirm page's calls pass; any other path under /confirm/ is the host's 404, never a page of the web build.
  const read = await call(`/confirm/v1/${confirm}`);
  assert.equal(read.status, 200, read.body);
  assert.equal(JSON.parse(read.body).type, "agent_freeze");
  assert.equal((await call(`/confirm/v1/${confirm}/open`, { body: {} })).status, 403, "opening still needs the owner's signature");
  for (const path of ["/confirm/", "/confirm/abc", "/confirm/v1/x", "/confirm/v1/x/open", `/confirm/${confirm}/x`]) await absent(path);
  await absent("/confirm/abc", "POST");
  // Only the confirm entry's own assets are served, as the web build's manifest lists them; the owner app's are not.
  const built = (() => { try { return JSON.parse(readFileSync(join(root, "web/dist/build-manifest.json"), "utf8")).entries as Record<string, { initial?: { js?: string[] } }>; } catch { return null; } })();
  for (const path of ["/static/js/missing.js", ...(built?.index?.initial?.js ?? []).filter(file => !built?.confirm?.initial?.js?.includes(file))]) await absent(path);
  for (const path of built?.confirm?.initial?.js ?? []) assert.equal((await call(path)).status, 200, path);

  // App setup: only the areas `appSetup` lists.
  const treasury = await app("/setup", await signedSetup("treasury"));
  assert.deepEqual([treasury.status, JSON.parse(treasury.body).error], [409, "This area is not available on this host"]);
  const payables = await app("/setup", await signedSetup("payables"));
  assert.equal(payables.status, 201, `${payables.body} ${diagnostics()}`);
  assert.match(JSON.parse(payables.body).agent, /^own-[0-9a-f]{24}$/);
});

test("app setup follows appSetup, not selfService: on a prototype host without selfService, sign-in setup is refused and app setup works", { timeout: 60_000 }, async t => {
  const { secret, call, app, signedSetup, diagnostics } = await startGateway(t, { host: HOST, appSetup: ["payables"], agents: [] });
  const signedIn = sessions({ cookie: "dao_session", secret, secure: true }).open("carol.near").split(";")[0]!;
  const gwSetup = await call("/gw/agents", { headers: { cookie: signedIn }, body: { owner: "carol.near", kind: "wallet", area: "payables" } });
  assert.deepEqual([gwSetup.status, JSON.parse(gwSetup.body).error], [403, "New agent setup is disabled on this host"]);
  const payables = await app("/setup", await signedSetup("payables"));
  assert.equal(payables.status, 201, `${payables.body} ${diagnostics()}`);
  const treasury = await app("/setup", await signedSetup("treasury"));
  assert.deepEqual([treasury.status, JSON.parse(treasury.body).error], [409, "This area is not available on this host"]);
});

test("a headless config refuses every sign-in or owner-app feature, and each deploy config keeps its setup areas", async () => {
  const { loadConfig } = await import("../src/gateway/config.js");
  const dir = mkdtempSync(join(tmpdir(), "platform-config-")), file = join(dir, "config.json");
  const load = (config: object) => { writeFileSync(file, JSON.stringify({ host: HOST, headless: true, appSetup: ["payables"], agents: [], ...config })); return loadConfig(file); };
  try {
    assert.equal(load({}).headless, true);
    for (const [extra, field] of [[{ hosts: { [HOST]: { demo: "showcase", agents: [], hostedAreas: ["payables"] } } }, "hosts"], [{ invoices: "https://i.test/" }, "invoices"],
      [{ invoiceUpstream: "https://i.test/" }, "invoiceUpstream"], [{ walkthroughs: true }, "walkthroughs"], [{ selfService: true }, "selfService"]] as const)
      assert.throws(() => load(extra), new RegExp(field), field);
    assert.throws(() => load({ appSetup: [] }), /Configure agents or enable setup/, "a host with nothing to serve doesn't start");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // The prototype's configs keep both setup paths as before; the platform's are headless and set up Payables agents only.
  // (shared-demos and shared-frontends name frontend directories that exist only in the deployed image: read as written.)
  for (const name of ["dashboard.json", "multiagency.json", "shared-demos.json", "shared-frontends.json"]) {
    const config = ["dashboard.json", "multiagency.json"].includes(name) ? loadConfig(join("deploy", name)) : JSON.parse(readFileSync(join("deploy", name), "utf8"));
    assert.deepEqual([config.headless ?? false, config.selfService, config.appSetup], [false, true, ["treasury", "payables"]], name);
  }
  for (const [name, host] of [["platform-staging.json", "api.dev.multiagency.ai"], ["platform.json", "api.multiagency.ai"]] as const) {
    const config = loadConfig(join("deploy", name));
    assert.deepEqual([config.host, config.headless, config.selfService, config.appSetup, config.agents], [host, true, false, ["payables"], []], name);
  }
});

test("the platform package carries the gateway and the confirm entry's files only: no owner app, no app frontends", async () => {
  const { execFileSync } = await import("node:child_process");
  const { existsSync, mkdirSync, statSync, readdirSync } = await import("node:fs");
  const tree = mkdtempSync(join(tmpdir(), "platform-tree-")), out = join(tmpdir(), `platform-package-${randomBytes(4).toString("hex")}`);
  const write = (path: string, content = path) => { mkdirSync(join(tree, path, ".."), { recursive: true }); writeFileSync(join(tree, path), content); };
  try {
    for (const path of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "src/gateway/server.ts", "Dockerfile.platform",
      "deploy/railway.gateway.json", "deploy/platform-entrypoint.sh", "deploy/platform-staging.json", "deploy/platform.json", "deploy/shared-frontends.json",
      "web/dist/index.html", "web/dist/confirm.html", "web/dist/static/js/index.1.js", "web/dist/static/js/confirm.2.js", "web/dist/static/js/lib.3.js",
      "web/dist/static/js/lib.3.js.LICENSE.txt", "web/dist/static/css/c.4.css", "web/dist/static/font/f.5.woff2", "frontends/treasury/index.html"]) write(path);
    write("package.json", JSON.stringify({ name: "platform-tree", private: true, type: "module" }));
    write("web/dist/build-manifest.json", JSON.stringify({ allFiles: [], integrity: {}, entries: {
      index: { html: ["/index.html"], initial: { js: ["/static/js/lib.3.js", "/static/js/index.1.js"], css: ["/static/css/c.4.css"] } },
      confirm: { html: ["/confirm.html"], initial: { js: ["/static/js/lib.3.js", "/static/js/confirm.2.js"], css: ["/static/css/c.4.css"] }, assets: ["/static/font/f.5.woff2"] } } }));
    execFileSync(process.execPath, [join(process.cwd(), "scripts/package-platform.mjs"), out], { cwd: tree, stdio: "pipe" });
    const files = (dir: string): string[] => readdirSync(join(out, dir), { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
    assert.deepEqual(files("web").sort(), ["web/dist/confirm.html", "web/dist/static/css/c.4.css", "web/dist/static/font/f.5.woff2",
      "web/dist/static/js/confirm.2.js", "web/dist/static/js/lib.3.js", "web/dist/static/js/lib.3.js.LICENSE.txt"]);
    assert.deepEqual(files("deploy").sort(), ["deploy/platform-entrypoint.sh", "deploy/platform-staging.json", "deploy/platform.json"]);
    assert.equal(existsSync(join(out, "frontends")), false);
    assert.equal(statSync(join(out, "deploy/platform-entrypoint.sh")).mode & 0o111, 0o111, "the entrypoint is executable");
    assert.equal(readFileSync(join(out, "Dockerfile"), "utf8"), "Dockerfile.platform");
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as { revisions: Record<string, unknown>; files: Record<string, string> };
    assert.deepEqual(Object.keys(manifest.revisions), ["platform"]);
    assert.ok(manifest.files["web/dist/confirm.html"] && !manifest.files["web/dist/index.html"]);
    assert.throws(() => execFileSync(process.execPath, [join(process.cwd(), "scripts/package-platform.mjs"), out], { cwd: tree, stdio: "pipe" }), /must not exist/);
  } finally { rmSync(tree, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); }
});
