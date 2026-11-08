import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { heldSwapShapes } from "../src/held-swap.js";
import { canonical } from "../src/mandate.js";

const USDC = "nep141:usdc.test", WNEAR = "nep141:wrap.near";
const sha = (op: object) => createHash("sha256").update(canonical(op)).digest("hex");
const data = { amount: "10000", token: USDC, token_out: WNEAR, min_amount_out: "4000000000000000000000" };

test("a held swap whose hash is the confidential swap op is outcome A: it binds what it buys and its floor", () => {
  const report = heldSwapShapes({ request_type: "confidential", request_data: data, request_hash: sha({ ...data, flow: "swap", kind: "confidential" }) });
  assert.equal(report.matched, "confidential swap op");
  assert.equal(report.outcome, "A");
  assert.equal(report.shapes.filter(s => s.matches).length, 1);
});

test("a hash over request_data that omits the output asset or floor is outcome B", () => {
  const spends = { amount: "10000", token: USDC, flow: "swap", kind: "confidential" };
  const report = heldSwapShapes({ request_type: "confidential", request_data: spends, request_hash: sha(spends) });
  assert.equal(report.matched, "request_data as given");
  assert.equal(report.outcome, "B");
});

test("a hash no candidate recomputes is outcome B, with no match", () => {
  const report = heldSwapShapes({ request_type: "confidential", request_data: data, request_hash: "0".repeat(64) });
  assert.equal(report.matched, null);
  assert.equal(report.outcome, "B");
  assert.ok(report.shapes.every(s => !s.matches));
});

test("inspect-held-swap only reads: it reports the matching shape of a held swap and sends nothing", { timeout: 30_000 }, async t => {
  const agent = "a".repeat(64), correlation = "held-swap", approvalId = "11111111-1111-4111-8111-111111111111";
  const methods: string[] = [];
  const provider = createServer((req, res) => {
    methods.push(`${req.method} ${req.url}`);
    const url = new URL(req.url!, "http://x");
    const body = url.pathname === "/v1/status"
      ? { correlation_id: correlation, agent_id: agent, type: "swap", status: "PENDING_APPROVAL", details: { approval_id: approvalId } }
      : url.pathname === `/v1/agents/${agent}/approvals/${approvalId}`
        ? { approval_id: approvalId, wallet_id: "w", wallet_pubkey: "ed25519:x", status: "PENDING", request_type: "confidential", request_data: data,
          request_hash: sha({ ...data, flow: "swap", kind: "confidential" }), required_approvals: 1, expires_at: new Date(Date.now() + 3_600_000).toISOString() }
        : url.pathname === `/v1/agents/${agent}/balances`
          ? { near_account_id: "x.near", source: "confidential", balances: [{ asset_id: USDC, balance_raw: "20000", available_raw: "10000" }, { asset_id: "nep141:other", balance_raw: "1", available_raw: "1" }] }
          : undefined;
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify(body ?? { error: "not found" }));
  });
  await new Promise<void>(done => provider.listen(0, "127.0.0.1", done));
  const dir = mkdtempSync(join(tmpdir(), "held-swap-"));
  t.after(() => { provider.close(); rmSync(dir, { recursive: true, force: true }); });
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", resolve("node_modules/tsx/dist/loader.mjs"), resolve("src/inspect-held-swap.ts"), correlation], {
    // FORCE_COLOR from the caller's terminal would colour console.dir and break the matches below.
    cwd: dir, env: { ...process.env, FORCE_COLOR: "0", AGENT_ID: agent, NEAR_INTENTS_AGENT_API_URL: `http://127.0.0.1:${(provider.address() as AddressInfo).port}` } });
  assert.match(stdout, /matched: 'confidential swap op'/);
  assert.match(stdout, /outcome: 'A'/);
  assert.match(stdout, /available_raw: '10000'/);
  assert.doesNotMatch(stdout, /nep141:other/, "only the swap's assets are reported");
  assert.ok(methods.length >= 3 && methods.every(m => m.startsWith("GET ")), `only reads: ${methods.join(", ")}`);
});
