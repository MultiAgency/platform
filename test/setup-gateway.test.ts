import { temporaryDirectories } from "./fixtures/harness.js";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { sessionToken } from "../src/signin.js";

const scratch = temporaryDirectories();

/** Real gateway, local fixtures: ownership evidence is separate from onboarding availability.
 * Count forwarded record reads to prove denied callers never reach the agent handler.
 */

const SECRET = "test-only-gateway-session-secret-0123456789";
const OWNER = "owner.near";
const UNRELATED_OWNER = "unrelated.near";
const reached: string[] = [];
const ownerReads: string[] = [];
let agentServers: Server[], rpcServer: Server, gateway: ChildProcess, base: string, dir: string;

const listen = (server: Server) => new Promise<number>((done) => server.listen(0, "127.0.0.1", () => done((server.address() as AddressInfo).port)));

let failWarm = false;
let failUnrelatedOwner = false;
const agentServer = (fails: () => boolean, identityFails = fails) => createServer((req, res) => {
  const path = req.url!.replace(/^\/rpc\//, "");
  if (path === "setup" && fails()) return res.writeHead(503).end();
  if (req.headers["x-gateway"]) {
    if (path === "ownerIdentity" && identityFails()) return res.writeHead(503).end();
    const setup = { agentId: "a".repeat(64), owner: { type: "near", account_id: OWNER } };
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ json: path === "ownerIdentity" ? setup : null }));
  }
  reached.push(path);
  res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=3600" }).end('{"json":null}');
});

before(async () => {
  agentServers = [agentServer(() => failWarm), agentServer(() => true), agentServer(() => false), agentServer(() => true, () => false)];
  rpcServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk)).on("end", () => {
      const { id, params } = JSON.parse(body) as { id: unknown; params: { account_id?: string } };
      ownerReads.push(params.account_id ?? "");
      if (params.account_id === UNRELATED_OWNER && failUnrelatedOwner)
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "Unrelated owner unavailable" } }));
      // The wallet owner has no contract, so it is not a DAO.
      const answer = { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: params.account_id } }, code: -32000, message: "Server error" } };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, ...answer }));
    });
  });
  const [walletPort, coldPort, unrelatedPort, setupOnlyPort, rpcPort] = await Promise.all([...agentServers.map(listen), listen(rpcServer)]);

  dir = scratch.create("setup-gateway");
  const file = join(dir, "dashboard.json");
  writeFileSync(file, JSON.stringify({ host: "dao.test", agents: [
    { name: "wallet", owner: OWNER, port: walletPort },
    { name: "cold", owner: OWNER, port: coldPort },
    { name: "unrelated", owner: UNRELATED_OWNER, port: unrelatedPort },
    { name: "setup-only", owner: OWNER, port: setupOnlyPort },
  ] }));
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((done) => probe.close(done));
  gateway = spawn(process.execPath, ["--import", join(process.cwd(), "node_modules/tsx/dist/loader.mjs"), join(process.cwd(), "src/gateway/server.ts")], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), DASHBOARD_FILE: file, SESSION_SECRET: SECRET, NEAR_RPC_URL: `http://127.0.0.1:${rpcPort}` },
    stdio: ["ignore", "pipe", "inherit"],
  });
  base = `http://127.0.0.1:${port}`;
  await new Promise<void>((done, fail) => {
    gateway.stdout!.on("data", (chunk: Buffer) => chunk.toString().includes("on port") && done());
    gateway.on("exit", (code) => fail(new Error(`The gateway exited (${code})`)));
  });
});

after(async () => {
  const stopped = gateway && gateway.exitCode === null && gateway.signalCode === null
    ? new Promise<void>(resolve => gateway.once("exit", () => resolve())) : Promise.resolve();
  gateway?.kill();
  await stopped;
  await Promise.all([...(agentServers ?? []), rpcServer].filter(Boolean)
    .map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

const call = (path: string, account?: string, agent = "wallet") =>
  fetch(`${base}/a/${agent}/rpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(account && { cookie: `dao_session=${sessionToken(account, SECRET)}` }) },
    body: "{}",
  });

test("a scoped read does not depend on another agent's owner lookup", async () => {
  ownerReads.length = 0;
  failUnrelatedOwner = true;
  try {
    assert.equal((await call("activity", OWNER, "wallet")).status, 200);
    assert.ok(!ownerReads.includes(UNRELATED_OWNER), "only the requested agent's owner is checked");
    const denied = await call("activity", "outsider.near", "wallet");
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).access, "agent", "a valid identity without access is an agent denial, not a lost session");
  } finally { failUnrelatedOwner = false; }
});

test("verified owner retains local read access while forwarded setup fails", async () => {
  assert.equal((await call("activity", OWNER, "wallet")).status, 200);
  failWarm = true;
  assert.equal((await call("setup", OWNER, "wallet")).status, 503);
  for (const path of ["activity", "unresolved", "owner/actions"])
    assert.equal((await call(path, OWNER, "wallet")).status, 200, path);
});
test("initial ownership verification does not depend on onboarding setup", async () => {
  assert.equal((await call("activity", OWNER, "setup-only")).status, 200);
  assert.equal((await call("setup", OWNER, "setup-only")).status, 503);
});
test("unverified owner remains denied when initial ownership evidence fails", async () => {
  reached.length = 0;
  for (const path of ["activity", "unresolved", "owner/actions"])
    assert.equal((await call(path, OWNER, "cold")).status, 403, path);
  assert.deepEqual(reached, []);
});
test("signed-out callers remain denied during setup failure", async () => {
  reached.length = 0;
  for (const path of ["activity", "unresolved", "owner/actions"])
    assert.equal((await call(path, undefined, "wallet")).status, 401, path);
  assert.deepEqual(reached, []);
});

// Remove state only after this suite has released its locks and stopped its processes.
after(scratch.cleanup);
