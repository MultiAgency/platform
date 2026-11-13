import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { test } from "node:test";
import { AgentApi } from "@near-intents-agent-api/sdk";
import { offlineEnvironment, offlineFiles, requireLiveConfiguration, liveFiles } from "../scripts/test-environment.mjs";
import { readOnlyProviderFetch } from "./fixtures/live-network.cjs";
import { rpcValue } from "./browser/fixtures/rpc.cjs";
import { timedPrices } from "./fixtures/authority.js";
import { validateBaseline } from "./e2e/challenge.mjs";
import { requireConfirmBuild } from "./e2e/environment.mjs";
import { missingConfirmFiles } from "../src/gateway/app-confirm.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

test("fault challenges accept a growing complete baseline and reject incomplete or unproven passes", () => {
  const titles = ["invoice, owner approval, and settlement stay distinct across the real stack",
    "accepted transfer with lost response stays unresolved after restart and blocks another send",
    "an agent connection reports for the contractor, recovers a lost reply by identity and follows the same request to paid",
    "owner recovery", "navigation", "wallet isolation", "strategy"];
  const specs = titles.map((title, index) => ({ id: String(index), title, tests: [{ projectId: "",
    expectedStatus: "passed", status: "expected", results: [{ status: "passed", retry: 0 }] }] }));
  const baseline = { suites: [{ specs }], errors: [], stats: { expected: 7, unexpected: 0, skipped: 0, flaky: 0 } };
  const discovered = { suites: [{ specs: specs.map(spec => ({ ...spec, tests: [{ projectId: "" }] })) }] };
  assert.doesNotThrow(() => validateBaseline(baseline, discovered));
  for (const change of [
    (report: typeof baseline) => { report.suites[0]!.specs.pop(); report.stats.expected--; },
    (report: typeof baseline) => { report.suites[0]!.specs[6] = structuredClone(report.suites[0]!.specs[0]!); },
    (report: typeof baseline) => { report.suites[0]!.specs[6]!.tests[0]!.results = []; },
    (report: typeof baseline) => { report.suites[0]!.specs[6]!.tests[0]!.results[0]!.status = "skipped"; },
    (report: typeof baseline) => { report.suites[0]!.specs[6]!.tests[0]!.results[0]!.status = "failed"; },
    (report: typeof baseline) => { report.suites[0]!.specs[6]!.tests[0]!.results[0]!.retry = 1; },
    (report: typeof baseline) => { report.suites[0]!.specs[6]!.tests[0]!.results.push({ status: "passed", retry: 1 }); },
  ]) {
    const changed = structuredClone(baseline); change(changed);
    assert.throws(() => validateBaseline(changed, discovered), /every discovered baseline/);
  }
});

test("offline launcher removes inherited credentials, instance settings and preloads", () => {
  const env = offlineEnvironment({ PATH: process.env.PATH, HOME: process.env.HOME,
    AGENT_GRANT_TOKEN: "sentinel", NEARAI_API_KEY: "sentinel", ENV_FILE: "/private/instance",
    NEAR_INTENTS_AGENT_API_URL: "https://provider.invalid", NODE_OPTIONS: "--require /private/preload",
    AUTOPILOT: "on", EXECUTOR: "on", HTTPS_PROXY: "https://proxy.invalid" });
  for (const key of ["AGENT_GRANT_TOKEN", "NEARAI_API_KEY", "ENV_FILE", "AUTOPILOT", "EXECUTOR", "NODE_OPTIONS", "HTTPS_PROXY"]) assert.equal(key in env, false, key);
  assert.equal(env.NEAR_INTENTS_AGENT_API_URL, "http://127.0.0.1:9");
  assert.deepEqual(liveFiles, ["execute-plan.test.ts"]);
});

test("explicit live verification refuses missing configuration instead of skipping", () => {
  assert.throws(() => requireLiveConfiguration({}), /No tests were started/);
  assert.throws(() => requireLiveConfiguration({ NEARAI_API_KEY: "sentinel" }), /AGENT_GRANT_TOKEN/);
  assert.doesNotThrow(() => requireLiveConfiguration(Object.fromEntries(
    ["NEAR_INTENTS_AGENT_API_KEY", "AGENT_ID", "AGENT_GRANT_TOKEN"].map(key => [key, "sentinel"]))));
});

test("offline discovery and explicit selections cannot load live suites", () => {
  const entries = ["source-analysis.test.ts", ...liveFiles, "fixtures"];
  assert.deepEqual(offlineFiles(entries), ["source-analysis.test.ts"]);
  assert.deepEqual(offlineFiles(entries, ["test/source-analysis.test.ts"]), ["source-analysis.test.ts"]);
  for (const name of [...liveFiles, "../outside.test.ts", "typo.test.ts"]) assert.throws(() => offlineFiles(entries, [name]), /Not a registered offline test/);
});

test("browser RPC fixtures reject unknown procedures and inherited object properties", () => {
  const responses = { overview: null, "autopilot/stop": undefined };
  assert.equal(rpcValue(responses, "overview"), null);
  assert.equal(rpcValue(responses, "autopilot/stop"), undefined);
  assert.throws(() => rpcValue(responses, "pay"), /Unexpected RPC/);
  assert.throws(() => rpcValue(responses, "toString"), /Unexpected RPC/);
});

test("fixture defaults do not overwrite explicit stale or unavailable price evidence", () => {
  const [token] = timedPrices([{ price: 1, price_updated_at: null, price_expires_at: "2000-01-01T00:00:00Z" }]);
  assert.equal(token!.price_updated_at, null);
  assert.equal(token!.price_expires_at, "2000-01-01T00:00:00Z");
});

test("offline preload blocks fetch and raw sockets, including fixture subprocesses", () => {
  const guard = fileURLToPath(new URL("./fixtures/offline-network.cjs", import.meta.url));
  const code = `
    const assert = require('node:assert/strict');
    assert.throws(() => require('node:net').connect(443, 'provider.invalid'), /Offline test blocked/);
    assert.throws(() => require('node:tls').connect({ host: 'provider.invalid', port: 443 }), /Offline test blocked/);
    fetch('https://provider.invalid').then(() => process.exit(2), error => assert.match(error.message, /Offline test blocked/));
  `;
  const result = spawnSync(process.execPath, ["-e", code], {
    env: { ...offlineEnvironment(), NODE_OPTIONS: `--require ${JSON.stringify(guard)}` }, encoding: "utf8", timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("offline network barrier still permits real loopback HTTP fixtures", async () => {
  const server = createServer((_req, res) => res.end("fixture"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    assert.equal(await (await fetch(`http://127.0.0.1:${address.port}`)).text(), "fixture");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("live barrier permits SDK quotes but blocks real grant submissions before transport", async () => {
  let transported = 0, blocked = 0;
  const transport = readOnlyProviderFetch(async () => {
    transported++;
    return new Response(JSON.stringify({ quote: { amount_out: "1", min_amount_out: "1" } }));
  }, "https://provider.invalid", () => blocked++);
  const api = new AgentApi({ apiKey: "naa_" + "x".repeat(43), baseUrl: "https://provider.invalid", fetch: transport });
  const grant = api.forGrant("ngt_" + "x".repeat(43));
  const request = { origin_asset: "a", destination_asset: "b", amount: "1", confidential: true };
  await grant.swap("agent", { ...request, dry: true });
  assert.equal(transported, 1);
  await assert.rejects(grant.swap("agent", request));
  await assert.rejects(grant.transfer("agent", { asset: "a", amount: "1", recipient: "fixture.near", confidential: true }));
  await assert.rejects(transport("https://provider.invalid/v1/owner/intents", { method: "POST", body: "{}" }));
  await assert.rejects(transport("https://provider.invalid/v1/agents/agent/swap", { method: "POST", body: '{"dry":"true"}' }));
  assert.equal(transported, 1, "no rejected request reaches transport");
  assert.equal(blocked, 4);
});

test("a swallowed live-barrier error still fails the test process", () => {
  const guard = fileURLToPath(new URL("./fixtures/live-network.cjs", import.meta.url));
  const code = `
    globalThis.fetch = () => { throw new Error('Transport must not run'); };
    require(${JSON.stringify(guard)});
    fetch('https://provider.invalid/v1/agents/agent/transfer', { method: 'POST', body: '{}' }).catch(() => {});
  `;
  const result = spawnSync(process.execPath, ["-e", code], {
    env: { ...offlineEnvironment(), PROTO_TEST_MODE: "live", NEAR_INTENTS_AGENT_API_URL: "https://provider.invalid" },
    encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, "");
});

test("the stack refuses to start without the confirm page's web build, naming the build to run", async () => {
  const dist = mkdtempSync(join(tmpdir(), "confirm-build-"));
  const write = (path: string, text = "") => { mkdirSync(dirname(join(dist, path)), { recursive: true }); writeFileSync(join(dist, path), text); };
  // No build at all: the gateway would answer the page 404.
  assert.deepEqual(missingConfirmFiles(dist), ["build-manifest.json"]);
  await assert.rejects(requireConfirmBuild(dist), /web build is missing or incomplete.*Run `pnpm build:web`/);
  // A build from before the confirm entry existed.
  write("build-manifest.json", JSON.stringify({ entries: { index: { html: ["/index.html"] } } }));
  assert.deepEqual(missingConfirmFiles(dist), ["build-manifest.json: the confirm entry"]);
  // The entry is listed but its page and scripts aren't there: the page would load blank.
  write("build-manifest.json", JSON.stringify({ entries: { confirm: { html: ["/confirm.html"],
    initial: { js: ["/static/js/lib.3.js", "/static/js/confirm.2.js"], css: ["/static/css/c.4.css"] } } } }));
  write("static/js/lib.3.js");
  assert.deepEqual(missingConfirmFiles(dist), ["/confirm.html", "/static/js/confirm.2.js", "/static/css/c.4.css"]);
  await assert.rejects(requireConfirmBuild(dist), /no \/confirm\.html, \/static\/js\/confirm\.2\.js, \/static\/css\/c\.4\.css/);
  for (const path of ["confirm.html", "static/js/confirm.2.js", "static/css/c.4.css"]) write(path);
  assert.deepEqual(missingConfirmFiles(dist), []);
  await requireConfirmBuild(dist);
});
