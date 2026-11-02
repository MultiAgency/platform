import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sessionToken } from "../src/signin.js";

const listen = (server: Server) => new Promise<number>(done => server.listen(0, "127.0.0.1", () => done((server.address() as AddressInfo).port)));
const freePort = async () => { const probe = createServer(); const port = await listen(probe); await new Promise(done => probe.close(done)); return port; };

test("the gateway talks to a supervised agent only after its own child says it is listening, never to another process on the port", { timeout: 20_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "gateway-listening-"));
  // Another process already holds `squatted`'s port, so the gateway's child for it can't bind.
  const received: string[] = [];
  const foreign = createServer((req, res) => { received.push(req.url!); res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ json: { agentId: "f".repeat(64), owner: { type: "near", account_id: "owner.near" } } })); });
  // NEAR RPC: the owner has no contract, so it is a wallet, not a DAO.
  const rpc = createServer((req, res) => { let body = ""; req.on("data", c => body += c).on("end", () => {
    const { id, params } = JSON.parse(body) as { id: unknown; params: { account_id?: string } };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, error: { name: "HANDLER_ERROR",
      cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: params.account_id } }, code: -32000, message: "Server error" } }));
  }); });
  const squattedPort = await listen(foreign), rpcPort = await listen(rpc), freeAgentPort = await freePort(), gatewayPort = await freePort();
  const secret = "synthetic-session-".repeat(3);
  for (const name of ["squatted", "running"]) writeFileSync(join(dir, `.env.${name}`), "");
  writeFileSync(join(dir, "dashboard.json"), JSON.stringify({ host: "fixture.test", agents: [
    { name: "squatted", owner: "owner.near", port: squattedPort, envFile: ".env.squatted" },
    { name: "running", owner: "owner.near", port: freeAgentPort, envFile: ".env.running" },
  ] }));
  const gateway = spawn(process.execPath, ["--import", resolve("node_modules/tsx/dist/loader.mjs"), resolve("test/fixtures/gateway-listening.ts")], {
    cwd: dir, env: { ...process.env, PORT: String(gatewayPort), SESSION_SECRET: secret, NEAR_RPC_URL: `http://127.0.0.1:${rpcPort}` }, stdio: "ignore" });
  const exited = once(gateway, "exit");
  t.after(async () => { gateway.kill("SIGKILL"); await exited; await new Promise(done => foreign.close(done)); await new Promise(done => rpc.close(done)); rmSync(dir, { recursive: true, force: true }); });
  const call = (agent: string) => fetch(`http://127.0.0.1:${gatewayPort}/a/${agent}/rpc/activity`, { method: "POST",
    headers: { "content-type": "application/json", cookie: `dao_session=${sessionToken("owner.near", secret)}` }, body: "{}" }).catch(() => undefined);
  let running: Response | undefined;
  for (let i = 0; i < 200 && running?.status !== 200; i++) { await delay(50); running = await call("running"); }
  assert.equal(running?.status, 200, "the agent whose child is listening answers through the gateway");
  assert.deepEqual((await running!.json()).json, { from: "child" });
  // Its owner check goes unanswered, as for a restarting server, so the agent stays closed.
  const squatted = await call("squatted");
  assert.equal(squatted?.status, 403, "an agent whose child never listened stays closed");
  assert.equal(received.length, 0, "nothing reaches the process that holds the port");

  // The running agent's child dies and another process takes its port within the owner check's cache: the gateway's
  // forward refuses instead of sending the call there.
  process.kill(Number(readFileSync(join(dir, `child-${freeAgentPort}.pid`), "utf8")), "SIGKILL");
  const taker = createServer((req, res) => { received.push(req.url!); res.end('{"json":null}'); });
  for (let i = 0; i < 100; i++) { try { await new Promise<void>((done, fail) => taker.once("error", fail).listen(freeAgentPort, "127.0.0.1", () => done())); break; } catch { await delay(20); } }
  t.after(() => new Promise(done => taker.close(done)));
  await delay(200);
  const after = await call("running");
  assert.equal(after?.status, 503, "the agent is unavailable until its own child listens again");
  assert.match((await after!.json()).error, /not running yet\. Nothing was sent/);
  assert.equal(received.length, 0, "nothing reaches the process that took the port");
});
